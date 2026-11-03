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
