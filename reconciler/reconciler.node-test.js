'use strict'

// Run with: npm run reconciler:test   (node's built-in runner; jest does not pick this file up)
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const lifecycle = require('../runtime/lifecycle')
const { createReconciler, pickAdopter } = require('./server')

const FAKE_SERVER = `const http = require('node:http')
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT))
`

let shared
const pids = new Set()

const baseConfig = (vmName, extra = {}) => ({
  sharedDir: shared,
  vmName,
  vmIp: '127.0.0.1',
  portMin: 23000,
  portMax: 23100,
  intervalMs: 1000,
  vmTimeoutMs: 20000,
  failuresBeforeRestart: 1,
  ...extra,
})

// a published release on the shared volume, with a stand-in server that answers /healthz
const makeRelease = (ait, appId, release) => {
  const dir = path.join(shared, 'apps', ait, appId, 'releases', String(release))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.js'), FAKE_SERVER)
  return dir
}

const entryFor = (appId, extra = {}) => ({
  appId,
  ait: 'ait-1',
  release: 1,
  vm: 'vm-a',
  ip: '127.0.0.1',
  port: 23050,
  pid: 999999,
  status: 'running',
  basePath: `/apps/${appId}`,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

const register = async entry => {
  await lifecycle.writeRegistry(shared, entry)
  return entry
}

before(() => {
  shared = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciler-test-'))
})

after(async () => {
  for (const e of await lifecycle.readRegistry(shared))
    lifecycle.stopProcess(e.pid)
  for (const pid of pids) lifecycle.stopProcess(pid)
  fs.rmSync(shared, { recursive: true, force: true })
})

test('leaves a healthy app alone', async () => {
  const releaseDir = makeRelease('ait-1', 'healthy-app', 1)
  const pid = lifecycle.startApp({
    releaseDir,
    port: 23001,
    basePath: '/apps/healthy-app',
  })
  pids.add(pid)
  await lifecycle.waitHealthy('127.0.0.1', 23001)
  const entry = await register(entryFor('healthy-app', { port: 23001, pid }))

  const actions = await createReconciler(baseConfig('vm-a')).tick()

  assert.deepEqual(actions, [])
  assert.deepEqual(await lifecycle.readEntry(shared, 'healthy-app'), entry)
})

test('restarts a dead app of this VM on the same port and updates the registry', async () => {
  makeRelease('ait-1', 'dead-app', 1)
  await register(entryFor('dead-app', { port: 23010 }))

  const actions = await createReconciler(baseConfig('vm-a')).tick()

  assert.deepEqual(
    actions.filter(a => a.appId === 'dead-app'),
    [{ appId: 'dead-app', action: 'restarted' }],
  )
  const after = await lifecycle.readEntry(shared, 'dead-app')
  assert.equal(after.port, 23010)
  assert.equal(after.status, 'running')
  assert.equal(after.restarts, 1)
  assert.notEqual(after.pid, 999999)
  assert.equal(await lifecycle.probe('127.0.0.1', 23010), true)
})

test('waits for the configured number of failures before restarting', async () => {
  makeRelease('ait-1', 'slow-app', 1)
  await register(entryFor('slow-app', { port: 23020 }))
  const reconciler = createReconciler(
    baseConfig('vm-a', { failuresBeforeRestart: 2 }),
  )

  assert.deepEqual(
    (await reconciler.tick()).filter(a => a.appId === 'slow-app'),
    [{ appId: 'slow-app', action: 'suspect' }],
  )
  assert.deepEqual(
    (await reconciler.tick()).filter(a => a.appId === 'slow-app'),
    [{ appId: 'slow-app', action: 'restarted' }],
  )
})

test('adopts an app from a VM with no heartbeat, moving it to this VM', async () => {
  makeRelease('ait-1', 'orphan-app', 1)
  await register(
    entryFor('orphan-app', { vm: 'vm-gone', ip: '10.9.9.9', port: 23030 }),
  )

  const actions = await createReconciler(baseConfig('vm-b')).tick()

  assert.deepEqual(
    actions.filter(a => a.appId === 'orphan-app'),
    [{ appId: 'orphan-app', action: 'adopted' }],
  )
  const after = await lifecycle.readEntry(shared, 'orphan-app')
  assert.equal(after.vm, 'vm-b')
  assert.equal(after.ip, '127.0.0.1')
  assert.equal(await lifecycle.probe('127.0.0.1', after.port), true)
})

test('does not touch an unhealthy app whose VM still has a fresh heartbeat', async () => {
  makeRelease('ait-1', 'theirs-app', 1)
  const entry = await register(
    entryFor('theirs-app', { vm: 'vm-live', port: 23040 }),
  )
  await lifecycle.writeHeartbeat(shared, { vm: 'vm-live', ip: '127.0.0.1' })

  const actions = await createReconciler(baseConfig('vm-b')).tick()

  assert.deepEqual(
    actions.filter(a => a.appId === 'theirs-app'),
    [{ appId: 'theirs-app', action: 'skipped' }],
  )
  assert.deepEqual(await lifecycle.readEntry(shared, 'theirs-app'), entry)
})

test('marks an app failed when its release is missing from the shared volume', async () => {
  await register(entryFor('lost-app', { port: 23060 }))

  const actions = await createReconciler(baseConfig('vm-a')).tick()

  assert.deepEqual(
    actions.filter(a => a.appId === 'lost-app'),
    [{ appId: 'lost-app', action: 'failed' }],
  )
  assert.equal((await lifecycle.readEntry(shared, 'lost-app')).status, 'failed')
})

test('writes a heartbeat for this VM', async () => {
  const before = Date.now()
  await createReconciler(baseConfig('vm-hb')).tick()
  assert.ok((await lifecycle.readHeartbeats(shared))['vm-hb'] >= before)
})

test('pickAdopter is stable and spreads apps across live VMs', () => {
  const live = ['vm-b', 'vm-a']
  const picks = [
    'app-one',
    'app-two',
    'app-three',
    'app-four',
    'app-five',
    'app-six',
  ].map(id => pickAdopter(id, live))
  assert.deepEqual(
    picks,
    [
      'app-one',
      'app-two',
      'app-three',
      'app-four',
      'app-five',
      'app-six',
    ].map(id => pickAdopter(id, [...live].reverse())),
  )
  assert.deepEqual([...new Set(picks)].sort(), ['vm-a', 'vm-b'])
})

// an app that is really running from a release on the shared volume
const runApp = async (appId, port, extra = {}) => {
  const releaseDir = makeRelease('ait-1', appId, 1)
  const pid = lifecycle.startApp({
    releaseDir,
    port,
    basePath: `/apps/${appId}`,
  })
  pids.add(pid)
  await lifecycle.waitHealthy('127.0.0.1', port)
  return register(entryFor(appId, { port, pid, ...extra }))
}

const gone = async port => {
  for (let i = 0; i < 20; i++) {
    if (!(await lifecycle.probe('127.0.0.1', port, 300))) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

test('stops the process of an app a user stopped, once', async () => {
  await runApp('stop-me', 23071, { status: 'stopped' })
  const reconciler = createReconciler(baseConfig('vm-a'))

  const first = await reconciler.tick()
  assert.deepEqual(
    first.filter(a => a.appId === 'stop-me'),
    [{ appId: 'stop-me', action: 'stopped' }],
  )
  assert.equal(await gone(23071), true)
  // the entry stays stopped and is not restarted
  assert.equal((await lifecycle.readEntry(shared, 'stop-me')).status, 'stopped')
  assert.deepEqual(
    (await reconciler.tick()).filter(a => a.appId === 'stop-me'),
    [],
  )
})

test('leaves the process of a stopped app on another VM to that VM', async () => {
  await runApp('their-stop', 23072, { status: 'stopped', vm: 'vm-other' })

  await createReconciler(baseConfig('vm-a')).tick()

  assert.equal(await lifecycle.probe('127.0.0.1', 23072), true)
})

test('deletes an app a user deleted: process, releases and registry entry', async () => {
  await runApp('delete-me', 23073, { status: 'deleting' })

  const actions = await createReconciler(baseConfig('vm-a')).tick()

  assert.deepEqual(
    actions.filter(a => a.appId === 'delete-me'),
    [{ appId: 'delete-me', action: 'deleted' }],
  )
  assert.equal(await gone(23073), true)
  assert.equal(await lifecycle.readEntry(shared, 'delete-me'), null)
  assert.equal(
    fs.existsSync(path.join(shared, 'apps', 'ait-1', 'delete-me')),
    false,
  )
})

test('does not delete an app that belongs to another live VM', async () => {
  makeRelease('ait-1', 'their-delete', 1)
  const entry = await register(
    entryFor('their-delete', {
      status: 'deleting',
      vm: 'vm-live2',
      port: 23074,
    }),
  )
  await lifecycle.writeHeartbeat(shared, { vm: 'vm-live2', ip: '127.0.0.1' })

  await createReconciler(baseConfig('vm-a')).tick()

  assert.deepEqual(await lifecycle.readEntry(shared, 'their-delete'), entry)
})

test('starts an app a user started, without counting it as a restart', async () => {
  makeRelease('ait-1', 'start-me', 1)
  await register(
    entryFor('start-me', { status: 'starting', port: 23075, restarts: 0 }),
  )

  const actions = await createReconciler(baseConfig('vm-a')).tick()

  assert.deepEqual(
    actions.filter(a => a.appId === 'start-me'),
    [{ appId: 'start-me', action: 'started' }],
  )
  const after = await lifecycle.readEntry(shared, 'start-me')
  assert.equal(after.status, 'running')
  assert.equal(after.restarts, 0)
  assert.equal(await lifecycle.probe('127.0.0.1', 23075), true)
})

test('never signals a process that is not a published app', () => {
  assert.equal(lifecycle.isAppProcess(process.pid), false)
  assert.equal(lifecycle.stopApp({ pid: process.pid }), false)
  assert.equal(lifecycle.stopApp({ pid: 999999 }), false)
})

test('removeApp refuses ids that could escape the shared directory', async () => {
  await assert.rejects(
    lifecycle.removeApp(shared, { ait: 'ait-1', appId: '../x' }),
    /invalid app/,
  )
  await assert.rejects(
    lifecycle.removeApp(shared, { ait: '..', appId: 'abc' }),
    /invalid app/,
  )
})
