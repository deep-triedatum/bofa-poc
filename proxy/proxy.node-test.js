'use strict'

// Run with: npm run proxy:test   (node's built-in runner; jest does not pick this file up)
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createProxy } = require('./server')

const listen = server =>
  new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  )

let shared,
  appServer,
  builderServer,
  slowAppServer,
  proxyServer,
  appPort,
  slowAppPort,
  proxyPort

const writeEntry = (appId, entry) => {
  fs.mkdirSync(path.join(shared, 'registry'), { recursive: true })
  fs.writeFileSync(
    path.join(shared, 'registry', `${appId}.json`),
    JSON.stringify({
      appId,
      vm: 'vm-test',
      ip: '127.0.0.1',
      status: 'running',
      ...entry,
    }),
  )
}
const get = (p, opts) =>
  fetch(`http://127.0.0.1:${proxyPort}${p}`, { redirect: 'manual', ...opts })

before(async () => {
  shared = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'))
  appServer = http.createServer((req, res) =>
    res.end(
      `app saw ${req.method} ${req.url} host=${req.headers.host} fwd=${req.headers['x-forwarded-host']}`,
    ),
  )
  builderServer = http.createServer((req, res) =>
    req.url === '/slow'
      ? setTimeout(() => res.end('builder slow'), 600)
      : res.end(`builder ${req.url}`),
  )
  slowAppServer = http.createServer((req, res) =>
    setTimeout(() => res.end('app slow'), 600),
  )
  appPort = await listen(appServer)
  slowAppPort = await listen(slowAppServer)
  const builderPort = await listen(builderServer)
  proxyServer = createProxy({
    sharedDir: shared,
    port: 0,
    builderUrl: new URL(`http://127.0.0.1:${builderPort}`),
    cacheMs: 0,
    appTimeoutMs: 300,
    builderTimeoutMs: 5000,
  })
  proxyPort = await listen(proxyServer)
  writeEntry('demo-app', { port: appPort })
})

after(() => {
  for (const s of [appServer, slowAppServer, builderServer, proxyServer])
    s.close()
  fs.rmSync(shared, { recursive: true, force: true })
})

test('forwards /apps/<id>/* to the registered VM and port, keeping the path', async () => {
  const res = await get('/apps/demo-app/assets/x.js?v=1')
  assert.equal(res.status, 200)
  assert.equal(
    await res.text(),
    `app saw GET /apps/demo-app/assets/x.js?v=1 host=127.0.0.1:${appPort} fwd=127.0.0.1:${proxyPort}`,
  )
})

test('adds the missing trailing slash with a redirect', async () => {
  const res = await get('/apps/demo-app?tab=1')
  assert.equal(res.status, 308)
  assert.equal(res.headers.get('location'), '/apps/demo-app/?tab=1')
})

test('404 for an app that is not registered', async () => {
  assert.equal((await get('/apps/nope-app/')).status, 404)
})

test('503 when the registry says the app is not running', async () => {
  writeEntry('stopped-app', { port: appPort, status: 'stopped' })
  assert.equal((await get('/apps/stopped-app/')).status, 503)
})

test('502 when the registered process is gone, and recovers once the registry is fixed', async () => {
  writeEntry('moved-app', { port: 1 })
  assert.equal((await get('/apps/moved-app/')).status, 502)
  writeEntry('moved-app', { port: appPort })
  assert.equal((await get('/apps/moved-app/')).status, 200)
})

test('everything outside /apps goes to the builder', async () => {
  assert.equal(await (await get('/')).text(), 'builder /')
  assert.equal(
    await (await get('/api/publish', { method: 'POST' })).text(),
    'builder /api/publish',
  )
})

test('rejects ids that are not valid app ids as non-app paths', async () => {
  assert.equal(
    await (await get('/apps/../etc/passwd')).text(),
    'builder /etc/passwd',
  )
})

test('an app that is too slow gets 502, but the builder may take longer (publish)', async () => {
  writeEntry('slow-app', { port: slowAppPort })
  assert.equal((await get('/apps/slow-app/')).status, 502)
  assert.equal(await (await get('/slow')).text(), 'builder slow')
})

test('health endpoint', async () => {
  assert.equal(await (await get('/_proxy/health')).text(), 'ok\n')
})
