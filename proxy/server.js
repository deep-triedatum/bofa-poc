'use strict'

// Stable-URL proxy. Runs identically on every VM from the shared volume.
//   /apps/<appId>/*  -> the VM and port in registry/<appId>.json
//   everything else  -> the builder UI (BUILDER_URL), so users have one entry point
// Dependency-free on purpose: nothing to install from a registry on the VMs.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const APP_PATH = /^\/apps\/([a-z0-9][a-z0-9-]{2,39})(\/.*)?$/
const HEALTH_PATH = '/_proxy/health'

const loadConfig = (env = process.env) => ({
  sharedDir: env.SHARED_DIR || path.resolve('.shared'),
  port: Number(env.PROXY_PORT || 8080),
  builderUrl: new URL(env.BUILDER_URL || 'http://127.0.0.1:3000'),
  cacheMs: Number(env.REGISTRY_CACHE_MS ?? 1000),
  // apps should answer quickly; the builder's /api/publish runs npm install and a build, which takes a while
  appTimeoutMs: Number(env.APP_TIMEOUT_MS || 30000),
  builderTimeoutMs: Number(env.BUILDER_TIMEOUT_MS || 600000),
})

// Reads one registry file per app, cached briefly so a busy app does not hit the shared volume on every request.
const createLookup = ({ sharedDir, cacheMs }) => {
  const cache = new Map()

  const lookup = appId => {
    const hit = cache.get(appId)
    if (hit && Date.now() - hit.at < cacheMs) return hit.entry

    let entry = null
    try {
      entry = JSON.parse(
        fs.readFileSync(
          path.join(sharedDir, 'registry', `${appId}.json`),
          'utf8',
        ),
      )
    } catch (e) {}
    cache.set(appId, { entry, at: Date.now() })
    return entry
  }
  lookup.forget = appId => cache.delete(appId)
  return lookup
}

const send = (res, status, message) => {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'Content-Type': 'text/plain' })
  res.end(`${message}\n`)
}

const forward = (req, res, target, timeoutMs, onError) => {
  const headers = { ...req.headers, host: `${target.host}:${target.port}` }
  delete headers.connection
  headers['x-forwarded-host'] = req.headers.host || ''
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'http'
  headers['x-forwarded-for'] = [
    req.headers['x-forwarded-for'],
    req.socket.remoteAddress,
  ]
    .filter(Boolean)
    .join(', ')

  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
      timeout: timeoutMs,
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')))
  upstream.on('error', err => onError(err))
  req.pipe(upstream)
}

const createProxy = (config = loadConfig()) => {
  const lookup = createLookup(config)
  const builder = {
    host: config.builderUrl.hostname,
    port: Number(config.builderUrl.port || 80),
  }

  return http.createServer((req, res) => {
    const { pathname, search } = new URL(req.url, 'http://proxy')

    if (pathname === HEALTH_PATH) return send(res, 200, 'ok')

    const match = APP_PATH.exec(pathname)
    if (!match) {
      return forward(req, res, builder, config.builderTimeoutMs, () =>
        send(res, 502, 'Builder is unreachable'),
      )
    }

    const [, appId, rest] = match
    // the app's assets live under /apps/<appId>/, so a bare /apps/<appId> must gain the slash
    if (!rest) {
      res.writeHead(308, { Location: `/apps/${appId}/${search}` })
      return res.end()
    }

    const entry = lookup(appId)
    if (!entry) return send(res, 404, `No published application "${appId}"`)
    if (entry.status !== 'running') {
      return send(res, 503, `Application "${appId}" is ${entry.status}`)
    }

    forward(
      req,
      res,
      { host: entry.ip, port: entry.port },
      config.appTimeoutMs,
      () => {
        // the registry may be stale (process died or moved): drop the cache so the next request re-reads it
        lookup.forget(appId)
        send(res, 502, `Application "${appId}" is not reachable on ${entry.vm}`)
      },
    )
  })
}

module.exports = { createProxy, loadConfig, createLookup }

if (require.main === module) {
  const config = loadConfig()
  createProxy(config).listen(config.port, () => {
    console.log(
      `proxy on :${config.port}, registry ${path.join(
        config.sharedDir,
        'registry',
      )}, builder ${config.builderUrl.origin}`,
    )
  })
}
