'use strict'

// Keeps the registry true. Runs identically on every VM from the shared volume.
// Every interval it:
//   1. writes this VM's heartbeat (vms/<vm>.json);
//   2. health-checks every registered app;
//   3. restarts apps of this VM that stopped answering, from their release on the shared volume;
//   4. adopts apps of a VM that is gone (no heartbeat and the app is not answering).
// The stable URL never changes: only the ip and port in registry/<appId>.json do.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const lifecycle = require('../runtime/lifecycle')

const loadConfig = (env = process.env) => ({
  sharedDir: env.SHARED_DIR || path.resolve('.shared'),
  vmName: env.VM_NAME || os.hostname(),
  vmIp: env.VM_IP || '127.0.0.1',
  portMin: Number(env.PORT_MIN || 20000),
  portMax: Number(env.PORT_MAX || 20999),
  intervalMs: Number(env.RECONCILE_INTERVAL_MS || 5000),
  // a VM whose heartbeat is older than this is treated as gone
  vmTimeoutMs: Number(env.VM_TIMEOUT_MS || 20000),
  // consecutive failed health checks before an app is restarted, so one slow response does not restart it
  failuresBeforeRestart: Number(env.FAILURES_BEFORE_RESTART || 2),
})

/**
 * Which live VM adopts an app. Every VM computes the same answer from the same heartbeats,
 * so no lock is needed: the app hashes to one of the sorted live VM names.
 */
const pickAdopter = (appId, liveVms) => {
  const sorted = [...liveVms].sort()
  const n = crypto
    .createHash('sha1')
    .update(appId)
    .digest()
    .readUInt32BE(0)
  return sorted[n % sorted.length]
}

const createReconciler = config => {
  const failures = new Map()

  const sameEntry = (a, b) =>
    a && b && a.vm === b.vm && a.pid === b.pid && a.updatedAt === b.updatedAt

  // Starts an app from its shared release on this VM and points the registry at it.
  const start = async (entry, registry) => {
    const releaseDir = lifecycle.releaseDirOf(config.sharedDir, entry)
    if (!fs.existsSync(path.join(releaseDir, 'server.js'))) {
      await lifecycle.writeRegistry(config.sharedDir, {
        ...entry,
        status: 'failed',
        updatedAt: new Date().toISOString(),
      })
      return 'failed'
    }

    const mine = entry.vm === config.vmName
    if (mine) {
      lifecycle.stopApp(entry)
      await new Promise(r => setTimeout(r, 300))
    }

    const claimed = registry
      .filter(e => e.vm === config.vmName && e.appId !== entry.appId)
      .map(e => e.port)
    const port = await lifecycle.allocatePort(
      config,
      claimed,
      mine ? entry.port : undefined,
    )
    const pid = lifecycle.startApp({
      releaseDir,
      port,
      basePath: entry.basePath,
    })

    try {
      await lifecycle.waitHealthy('127.0.0.1', port)
    } catch {
      lifecycle.stopProcess(pid)
      return 'start-failed'
    }

    // another reconciler or a publish may have changed the entry while we were starting
    const current = await lifecycle.readEntry(config.sharedDir, entry.appId)
    if (!sameEntry(current, entry)) {
      lifecycle.stopProcess(pid)
      return 'superseded'
    }

    await lifecycle.writeRegistry(config.sharedDir, {
      ...entry,
      vm: config.vmName,
      ip: config.vmIp,
      port,
      pid,
      status: 'running',
      restarts:
        entry.status === 'running'
          ? (entry.restarts || 0) + 1
          : entry.restarts || 0,
      updatedAt: new Date().toISOString(),
    })
    if (entry.status === 'starting') return 'started'
    return mine ? 'restarted' : 'adopted'
  }

  const tick = async (now = Date.now()) => {
    await lifecycle.writeHeartbeat(
      config.sharedDir,
      { vm: config.vmName, ip: config.vmIp },
      now,
    )

    const beats = await lifecycle.readHeartbeats(config.sharedDir)
    const live = new Set(
      Object.entries(beats)
        .filter(([, at]) => now - at < config.vmTimeoutMs)
        .map(([vm]) => vm),
    )
    live.add(config.vmName)

    const registry = await lifecycle.readRegistry(config.sharedDir)
    const actions = []

    for (const entry of registry) {
      const { appId } = entry
      const mine = entry.vm === config.vmName
      // this VM acts for its own apps, and for apps of a VM that is gone if it is the elected adopter
      const responsible =
        mine ||
        (!live.has(entry.vm) && pickAdopter(appId, live) === config.vmName)

      // states a user asked for from the builder, which cannot reach processes on other VMs
      if (entry.status === 'stopped') {
        if (mine && lifecycle.stopApp(entry)) {
          actions.push({ appId, action: 'stopped' })
        }
        continue
      }
      if (entry.status === 'deleting') {
        if (!responsible) continue
        if (mine) lifecycle.stopApp(entry)
        await lifecycle.removeApp(config.sharedDir, entry)
        actions.push({ appId, action: 'deleted' })
        continue
      }
      if (entry.status === 'starting') {
        if (!responsible) continue
        let action
        try {
          action = await start(entry, registry)
        } catch (e) {
          action = `error: ${e.message}`
        }
        if (action === 'start-failed') {
          await lifecycle.writeRegistry(config.sharedDir, {
            ...entry,
            status: 'failed',
            updatedAt: new Date().toISOString(),
          })
        }
        actions.push({ appId, action })
        continue
      }

      if (entry.status !== 'running') continue

      const healthy = await lifecycle.probe(
        mine ? '127.0.0.1' : entry.ip,
        entry.port,
      )
      if (healthy) {
        failures.delete(appId)
        continue
      }

      // an app on another live VM is that VM's reconciler's job
      if (!mine && live.has(entry.vm)) {
        actions.push({ appId, action: 'skipped' })
        continue
      }

      const count = (failures.get(appId) || 0) + 1
      failures.set(appId, count)
      if (count < config.failuresBeforeRestart) {
        actions.push({ appId, action: 'suspect' })
        continue
      }

      if (!mine && pickAdopter(appId, live) !== config.vmName) {
        actions.push({ appId, action: 'left-to-other-vm' })
        continue
      }

      let action
      try {
        action = await start(entry, registry)
      } catch (e) {
        action = `error: ${e.message}`
      }
      if (action === 'restarted' || action === 'adopted') failures.delete(appId)
      actions.push({ appId, action })
    }
    return actions
  }

  return { tick, failures }
}

module.exports = { createReconciler, loadConfig, pickAdopter }

if (require.main === module) {
  const config = loadConfig()
  const reconciler = createReconciler(config)
  let stopping = false
  let wake = () => {}
  // finish the tick in progress, but do not sit out the rest of the interval
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopping = true
      wake()
    })
  }

  console.log(
    `reconciler on ${config.vmName} (${config.vmIp}), registry ${config.sharedDir}`,
  )
  ;(async () => {
    // published apps run detached, so stopping the reconciler leaves them running
    while (!stopping) {
      try {
        for (const a of await reconciler.tick()) {
          console.log(new Date().toISOString(), a.appId, a.action)
        }
      } catch (e) {
        console.error('tick failed:', e.message)
      }
      if (stopping) break
      await new Promise(resolve => {
        const timer = setTimeout(resolve, config.intervalMs)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  })()
}
