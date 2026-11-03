import lifecycle from '../../runtime/lifecycle'
import {
  loadConfig,
  PublishConfig,
  PublishError,
  RegistryEntry,
} from './publisher'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/

export type AppStatus = RegistryEntry['status']

export type AppInfo = RegistryEntry & {
  /** Stable URL through the proxy, or a relative path when PUBLIC_BASE_URL is not set */
  url: string
  /** Direct URL to the VM that runs the app */
  directUrl: string
  /** The app answered /healthz just now */
  healthy: boolean
}

const entryOrThrow = async (appId: string, config: PublishConfig) => {
  if (!ID_PATTERN.test(appId)) {
    throw new PublishError('invalid app id', 400)
  }
  const entry: RegistryEntry | null = await lifecycle.readEntry(
    config.sharedDir,
    appId,
  )
  if (!entry) throw new PublishError(`No application "${appId}"`, 404)
  return entry
}

const save = (config: PublishConfig, entry: RegistryEntry) =>
  lifecycle.writeRegistry(config.sharedDir, {
    ...entry,
    updatedAt: new Date().toISOString(),
  })

/** Published apps, optionally of one AIT, with a live health check for the running ones. */
export const listApps = async (
  { ait }: { ait?: string } = {},
  config = loadConfig(),
): Promise<AppInfo[]> => {
  const entries: RegistryEntry[] = await lifecycle.readRegistry(
    config.sharedDir,
  )

  return Promise.all(
    entries
      .filter(e => !ait || e.ait === ait)
      .sort((a, b) => a.appId.localeCompare(b.appId))
      .map(async e => ({
        ...e,
        url: `${config.publicBaseUrl}${e.basePath}/`,
        directUrl: `http://${e.ip}:${e.port}${e.basePath}/`,
        healthy:
          e.status === 'running' &&
          (await lifecycle.probe(
            e.vm === config.vmName ? '127.0.0.1' : e.ip,
            e.port,
            1500,
          )),
      })),
  )
}

/**
 * Stops an app. The entry is marked `stopped`, which also keeps the reconciler from restarting it.
 * A process on this VM is stopped now; a process on another VM is stopped by that VM's reconciler.
 */
export const stopApp = async (appId: string, config = loadConfig()) => {
  const entry = await entryOrThrow(appId, config)
  if (entry.status === 'deleting') {
    throw new PublishError(`"${appId}" is being deleted`, 409)
  }
  if (entry.vm === config.vmName) lifecycle.stopApp(entry)
  await save(config, { ...entry, status: 'stopped' })
}

/** Asks for a stopped or failed app to be started again. The reconciler starts it from its release. */
export const startApp = async (appId: string, config = loadConfig()) => {
  const entry = await entryOrThrow(appId, config)
  if (entry.status === 'running' || entry.status === 'starting') return
  if (entry.status === 'deleting') {
    throw new PublishError(`"${appId}" is being deleted`, 409)
  }
  await save(config, { ...entry, status: 'starting' })
}

/**
 * Deletes an app: process, every release and the registry entry. On this VM it happens now;
 * for an app on another VM the entry is marked `deleting` and that VM's reconciler finishes it.
 */
export const deleteApp = async (appId: string, config = loadConfig()) => {
  const entry = await entryOrThrow(appId, config)
  if (entry.vm === config.vmName) {
    lifecycle.stopApp(entry)
    await lifecycle.removeApp(config.sharedDir, entry)
    return { deleted: true }
  }
  await save(config, { ...entry, status: 'deleting' })
  return { deleted: false }
}
