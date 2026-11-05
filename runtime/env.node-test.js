'use strict'

// Run with: npm run env:test   (node's built-in runner; jest does not pick this file up)
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const lifecycle = require('./lifecycle')
const env = require('./env')

let shared
before(() => {
  shared = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'))
})
after(() => fs.rmSync(shared, { recursive: true, force: true }))

const app = (extra = {}) => ({ appId: 'my-app', ait: 'ait-1', ...extra })

test('an app with no namespaces has no variables and an empty hash', async () => {
  const r = await env.resolveEnv(shared, app())
  assert.deepEqual(r, { vars: {}, hash: '', missing: [], denied: [] })
})

test('namespaces merge in order, later wins, then the app own variables', async () => {
  await env.updateNamespace(shared, 'common', {
    ait: 'ait-1',
    set: { LOG: 'info', DB: 'db1' },
  })
  await env.updateNamespace(shared, 'overrides', {
    ait: 'ait-1',
    set: { LOG: 'debug' },
  })
  await env.updateAppVars(shared, app(), { set: { DB: 'private-db' } })

  const r = await env.resolveEnv(shared, app({ envNamespaces: ['common', 'overrides'] }))
  assert.deepEqual(r.vars, { LOG: 'debug', DB: 'private-db' })

  const flipped = await env.resolveEnv(shared, app({ envNamespaces: ['overrides', 'common'] }))
  assert.equal(flipped.vars.LOG, 'info')
})

test('two apps can use the same namespace', async () => {
  const a = await env.resolveEnv(shared, { appId: 'app-one', ait: 'ait-1', envNamespaces: ['common'] })
  const b = await env.resolveEnv(shared, { appId: 'app-two', ait: 'ait-1', envNamespaces: ['common'] })
  assert.deepEqual(a.vars, b.vars)
  assert.deepEqual((await env.appsUsing(shared, 'common')), [])
})

test('the hash changes when a namespace or the private variables change, and never contains values', async () => {
  const entry = app({ envNamespaces: ['common'] })
  const before = (await env.resolveEnv(shared, entry)).hash
  assert.notEqual(before, '')
  await env.updateNamespace(shared, 'common', { set: { LOG: 'warn' } })
  const after = (await env.resolveEnv(shared, entry)).hash
  assert.notEqual(after, before)
  assert.equal(
    (await env.resolveEnv(shared, entry)).hash,
    after,
    'stable when nothing changed',
  )
  await env.updateNamespace(shared, 'common', { set: { SECRET: 'hunter2' } })
  const file = fs.readFileSync(path.join(shared, 'env/namespaces/common.json'), 'utf8')
  assert.ok(file.includes('hunter2'))
  assert.ok(!(await env.resolveEnv(shared, entry)).hash.includes('hunter2'))
})

test('PORT, BASE_PATH and node-altering variables cannot be set', async () => {
  for (const key of ['PORT', 'BASE_PATH', 'NODE_OPTIONS', 'PATH', 'LD_PRELOAD']) {
    await assert.rejects(
      env.updateNamespace(shared, 'common', { set: { [key]: 'x' } }),
      { status: 400 },
    )
  }
})

test('bad names and values are refused', async () => {
  await assert.rejects(env.updateNamespace(shared, 'common', { set: { 'A-B': 'x' } }), { status: 400 })
  await assert.rejects(env.updateNamespace(shared, 'common', { set: { A: 5 } }), { status: 400 })
  await assert.rejects(env.updateNamespace(shared, 'common', { set: { A: 'x'.repeat(5000) } }), { status: 400 })
  await assert.rejects(env.updateNamespace(shared, '../x', { ait: 'ait-1' }), { status: 400 })
})

test('a namespace of another AIT is denied unless it is shared', async () => {
  await env.updateNamespace(shared, 'ait2-only', { ait: 'ait-2', set: { K: 'v' } })
  const other = { appId: 'other-app', ait: 'ait-1', envNamespaces: ['ait2-only'] }
  assert.deepEqual((await env.resolveEnv(shared, other)).denied, ['ait2-only'])
  assert.deepEqual((await env.resolveEnv(shared, other)).vars, {})
  await assert.rejects(env.assertAttachable(shared, other), { status: 403 })

  await env.updateNamespace(shared, 'ait2-only', { ait: 'ait-2', shared: true })
  assert.deepEqual((await env.resolveEnv(shared, other)).vars, { K: 'v' })
  await env.assertAttachable(shared, other)
})

test('only the owning AIT can change a namespace', async () => {
  await assert.rejects(env.updateNamespace(shared, 'ait2-only', { ait: 'ait-1', set: { K: 'x' } }), { status: 403 })
})

test('a missing namespace is reported, and cannot be attached', async () => {
  const entry = app({ envNamespaces: ['nope-ns'] })
  assert.deepEqual((await env.resolveEnv(shared, entry)).missing, ['nope-ns'])
  await assert.rejects(env.assertAttachable(shared, entry), { status: 404 })
})

test('a namespace in use cannot be deleted', async () => {
  await lifecycle.writeRegistry(shared, {
    appId: 'my-app',
    ait: 'ait-1',
    envNamespaces: ['overrides'],
  })
  await assert.rejects(env.deleteNamespace(shared, 'overrides'), { status: 409 })
  await lifecycle.removeApp(shared, { ait: 'ait-1', appId: 'my-app' })
  await env.deleteNamespace(shared, 'overrides')
  assert.equal(await env.readNamespace(shared, 'overrides'), null)
  await assert.rejects(env.deleteNamespace(shared, 'overrides'), { status: 404 })
})

test('removing an app removes its private variables', async () => {
  await env.updateAppVars(shared, app(), { set: { A: '1' } })
  await lifecycle.removeApp(shared, { ait: 'ait-1', appId: 'my-app' })
  assert.equal(await env.readAppVars(shared, 'my-app'), null)
})

test('env files are readable only by their owner', async () => {
  const mode = fs.statSync(path.join(shared, 'env/namespaces/common.json')).mode & 0o777
  assert.equal(mode, 0o600)
})

test('unset removes a variable', async () => {
  const ns = await env.updateNamespace(shared, 'common', { unset: ['SECRET'] })
  assert.ok(!('SECRET' in ns.vars))
})

test('saving a namespace without changing a value keeps its revision, so nothing restarts', async () => {
  const entry = { appId: 'rev-app', ait: 'ait-1', envNamespaces: ['common'] }
  const before = (await env.resolveEnv(shared, entry)).hash
  await env.updateNamespace(shared, 'common', { set: { LOG: (await env.readNamespace(shared, 'common')).vars.LOG } })
  await env.updateNamespace(shared, 'common', { shared: false })
  assert.equal((await env.resolveEnv(shared, entry)).hash, before)
})
