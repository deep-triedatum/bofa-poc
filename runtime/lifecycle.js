'use strict'

// App lifecycle shared by the publisher (src/server/publisher.ts) and the reconciler (reconciler/server.js):
// ports, starting a release, health checks, the registry and VM heartbeats. Plain CommonJS with no
// dependencies so the reconciler can run under plain `node` on every VM.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

const registryDir = sharedDir => path.join(sharedDir, 'registry')
const heartbeatDir = sharedDir => path.join(sharedDir, 'vms')

/** Where the files of an entry's release live on the shared volume. */
const releaseDirOf = (sharedDir, entry) =>
  path.join(
    sharedDir,
    'apps',
    entry.ait,
    entry.appId,
    'releases',
    String(entry.release),
  )

const isPortFree = port =>
  new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '0.0.0.0')
  })

/**
 * A port that is free on this VM and not claimed by another registry entry for this VM.
 * `preferred` is tried first so a restarted app keeps its port when it can.
 */
const allocatePort = async ({ portMin, portMax }, claimed, preferred) => {
  const candidates = []
  if (preferred) candidates.push(preferred)
  for (let p = portMin; p <= portMax; p++) candidates.push(p)
  for (const port of candidates) {
    if (!claimed.includes(port) && (await isPortFree(port))) return port
  }
  const error = new Error(`No free port between ${portMin} and ${portMax}`)
  error.status = 503
  throw error
}

/** One GET /healthz. */
const probe = async (host, port, timeoutMs = 2000) => {
  try {
    const res = await fetch(`http://${host}:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

const waitHealthy = async (host, port, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(host, port)) return
    await new Promise(r => setTimeout(r, 250))
  }
  const error = new Error(`App did not become healthy on port ${port}`)
  error.status = 502
  throw error
}

/** Starts `node server.js` from a release directory, detached. Returns the pid. */
const startApp = ({ releaseDir, port, basePath }) => {
  const logFd = fs.openSync(path.join(releaseDir, 'app.log'), 'a')
  const child = spawn('node', ['server.js'], {
    cwd: releaseDir,
    env: { ...process.env, PORT: String(port), BASE_PATH: basePath },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  fs.closeSync(logFd)
  return child.pid
}

const stopProcess = pid => {
  try {
    process.kill(pid)
  } catch {}
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/

/**
 * True when `pid` is a published app's `node server.js`. A pid from the registry may have been
 * recycled by an unrelated process, so anything that stops an app by pid checks this first.
 * Without /proc (not Linux) there is nothing to check against, so the registry is trusted.
 */
const isAppProcess = pid => {
  if (!pid || !fs.existsSync('/proc/self')) return Boolean(pid)
  try {
    const [bin, script] = fs
      .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
    return path.basename(bin) === 'node' && script === 'server.js'
  } catch {
    return false
  }
}

/** Stops the app process of a registry entry that runs on this VM. Returns true if a process was signalled. */
const stopApp = entry => {
  if (!entry || !isAppProcess(entry.pid)) return false
  stopProcess(entry.pid)
  return true
}

/** Deletes an app's releases and its registry entry. The caller stops the process first. */
const removeApp = async (sharedDir, { ait, appId }) => {
  if (!ID_PATTERN.test(ait) || !ID_PATTERN.test(appId)) {
    throw new Error(`refusing to remove invalid app ${ait}/${appId}`)
  }
  await fsp.rm(path.join(sharedDir, 'apps', ait, appId), {
    recursive: true,
    force: true,
  })
  await fsp.rm(path.join(registryDir(sharedDir), `${appId}.json`), {
    force: true,
  })
}

const readEntry = async (sharedDir, appId) => {
  try {
    return JSON.parse(
      await fsp.readFile(
        path.join(registryDir(sharedDir), `${appId}.json`),
        'utf8',
      ),
    )
  } catch {
    return null
  }
}

const readRegistry = async sharedDir => {
  const names = await fsp.readdir(registryDir(sharedDir)).catch(() => [])
  const entries = []
  for (const name of names.filter(n => n.endsWith('.json'))) {
    const entry = await readEntry(sharedDir, name.slice(0, -'.json'.length))
    if (entry) entries.push(entry)
  }
  return entries
}

// temp file + rename is atomic on the same filesystem, so readers never see half a file
const writeAtomic = async (file, data) => {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2))
  await fsp.rename(tmp, file)
}

const writeRegistry = (sharedDir, entry) =>
  writeAtomic(path.join(registryDir(sharedDir), `${entry.appId}.json`), entry)

const writeHeartbeat = (sharedDir, { vm, ip }, now = Date.now()) =>
  writeAtomic(path.join(heartbeatDir(sharedDir), `${vm}.json`), {
    vm,
    ip,
    updatedAt: now,
  })

/** Map of vm name to last heartbeat (ms since epoch). */
const readHeartbeats = async sharedDir => {
  const names = await fsp.readdir(heartbeatDir(sharedDir)).catch(() => [])
  const beats = {}
  for (const name of names.filter(n => n.endsWith('.json'))) {
    try {
      const beat = JSON.parse(
        await fsp.readFile(path.join(heartbeatDir(sharedDir), name), 'utf8'),
      )
      beats[beat.vm] = beat.updatedAt
    } catch {}
  }
  return beats
}

module.exports = {
  releaseDirOf,
  isPortFree,
  allocatePort,
  probe,
  waitHealthy,
  startApp,
  stopProcess,
  isAppProcess,
  stopApp,
  removeApp,
  readEntry,
  readRegistry,
  writeRegistry,
  writeHeartbeat,
  readHeartbeats,
}
