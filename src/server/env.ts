import lifecycle from '../../runtime/lifecycle'
import envStore from '../../runtime/env'
import {
  loadConfig,
  PublishConfig,
  PublishError,
  RegistryEntry,
} from './publisher'

// Values are write-only: everything here returns variable NAMES, never values.

export type NamespaceInfo = {
  name: string
  ait: string
  shared: boolean
  keys: string[]
  usedBy: string[]
  updatedAt: string
}

export type Changes = { set?: Record<string, string>; unset?: string[] }

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (e) {
    const status = (e as { status?: number }).status || 500
    throw new PublishError((e as Error).message, status)
  }
}

const info = async (
  config: PublishConfig,
  ns: {
    name: string
    ait: string
    shared: boolean
    vars: Record<string, string>
    updatedAt: string
  },
): Promise<NamespaceInfo> => ({
  name: ns.name,
  ait: ns.ait,
  shared: ns.shared,
  keys: Object.keys(ns.vars).sort(),
  usedBy: await envStore.appsUsing(config.sharedDir, ns.name),
  updatedAt: ns.updatedAt,
})

/** Namespaces, optionally the ones an AIT may attach: its own plus the shared ones. */
export const listNamespaces = async (
  { ait }: { ait?: string } = {},
  config = loadConfig(),
) =>
  wrap(async () => {
    const all = await envStore.listNamespaces(config.sharedDir)
    return Promise.all(
      all
        .filter((n: { ait: string; shared: boolean }) => !ait || n.ait === ait || n.shared)
        .map((n: Parameters<typeof info>[1]) => info(config, n)),
    )
  })

export const getNamespace = async (name: string, config = loadConfig()) =>
  wrap(async () => {
    const ns = await envStore.readNamespace(config.sharedDir, name)
    if (!ns) throw new PublishError(`No namespace "${name}"`, 404)
    return info(config, ns)
  })

/** Creates a namespace or changes it. The AIT is required when creating. */
export const saveNamespace = async (
  name: string,
  body: Changes & { ait?: string; shared?: boolean },
  config = loadConfig(),
) =>
  wrap(async () =>
    info(config, await envStore.updateNamespace(config.sharedDir, name, body)),
  )

export const deleteNamespace = async (name: string, config = loadConfig()) =>
  wrap(() => envStore.deleteNamespace(config.sharedDir, name))

export type AppEnvInfo = {
  appId: string
  namespaces: string[]
  /** Names of the variables private to this app */
  keys: string[]
  /** Names of every variable the app starts with, after merging */
  effectiveKeys: string[]
  missing: string[]
  denied: string[]
  /** The running process already has the current variables */
  applied: boolean
}

const entryOf = async (appId: string, config: PublishConfig) => {
  const entry: RegistryEntry | null = /^[a-z0-9][a-z0-9-]{2,39}$/.test(appId)
    ? await lifecycle.readEntry(config.sharedDir, appId)
    : null
  if (!entry) throw new PublishError(`No application "${appId}"`, 404)
  return entry
}

export const getAppEnv = async (
  appId: string,
  config = loadConfig(),
): Promise<AppEnvInfo> =>
  wrap(async () => {
    const entry = await entryOf(appId, config)
    const env = await envStore.resolveEnv(config.sharedDir, entry)
    const own = await envStore.readAppVars(config.sharedDir, appId)
    return {
      appId,
      namespaces: entry.envNamespaces || [],
      keys: Object.keys(own?.vars || {}).sort(),
      effectiveKeys: Object.keys(env.vars).sort(),
      missing: env.missing,
      denied: env.denied,
      applied: (entry.envHash || '') === env.hash,
    }
  })

/**
 * Attaches namespaces to an app and/or changes its private variables. The app is not touched here:
 * the reconciler on its VM sees that the variables changed and restarts it within one interval.
 */
export const saveAppEnv = async (
  appId: string,
  body: Changes & { namespaces?: string[] },
  config = loadConfig(),
) =>
  wrap(async () => {
    const entry = await entryOf(appId, config)
    if (entry.status === 'deleting') {
      throw new PublishError(`"${appId}" is being deleted`, 409)
    }
    if (body.namespaces !== undefined) {
      await envStore.assertAttachable(config.sharedDir, {
        appId,
        ait: entry.ait,
        envNamespaces: body.namespaces,
      })
    }
    if (body.set || body.unset) {
      await envStore.updateAppVars(config.sharedDir, entry, body)
    }
    if (body.namespaces !== undefined) {
      // re-read: the entry may have been rewritten while we validated
      const latest = (await entryOf(appId, config)) as RegistryEntry
      await lifecycle.writeRegistry(config.sharedDir, {
        ...latest,
        envNamespaces: body.namespaces,
        updatedAt: new Date().toISOString(),
      })
    }
    return getAppEnv(appId, config)
  })
