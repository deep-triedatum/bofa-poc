'use strict'

// Environment variables for published apps, shared by the builder (src/server/env.ts) and the
// reconciler. Variables live in namespaces on the shared volume, so several apps can use the same
// values and every VM sees the same ones:
//
//   env/namespaces/<name>.json   { name, ait, shared, vars, rev }   attached to apps by name
//   env/apps/<appId>.json        { appId, ait, vars, rev }          private to one app
//
// An app's variables are its `envNamespaces` (in order, later wins) and then its private variables.
// PORT and BASE_PATH are set by the platform afterwards and can never be overridden.

const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const path = require('node:path')
const lifecycle = require('./lifecycle')

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_VALUE_LENGTH = 4096
const MAX_VARS = 200
// owned by the platform, or able to change how node itself runs
const RESERVED = new Set([
  'PORT',
  'BASE_PATH',
  'NODE_OPTIONS',
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
])

const httpError = (message, status) => {
  const error = new Error(message)
  error.status = status
  return error
}

const namespaceFile = (sharedDir, name) =>
  path.join(sharedDir, 'env', 'namespaces', `${name}.json`)
const appFile = (sharedDir, appId) =>
  path.join(sharedDir, 'env', 'apps', `${appId}.json`)

const readJson = async file => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

// owner-only: the values may be secrets
const writeEnvFile = (file, data) =>
  lifecycle.writeAtomic(file, data, { mode: 0o600 })

const assertId = (value, what) => {
  if (!ID_PATTERN.test(value)) {
    throw httpError(`${what} must be 3-40 chars: lowercase letters, digits, dashes`, 400)
  }
}

/**
 * Applies `set` and `unset` to a vars map, checking every key and value. Returns a new map.
 * @param {Record<string, string>} current
 * @param {{ set?: Record<string, string>, unset?: string[] }} [changes]
 */
const applyChanges = (current, { set = {}, unset = [] } = {}) => {
  const vars = { ...current }
  for (const key of unset) delete vars[key]
  for (const [key, value] of Object.entries(set)) {
    if (!KEY_PATTERN.test(key)) {
      throw httpError(`invalid variable name "${key}"`, 400)
    }
    if (RESERVED.has(key)) {
      throw httpError(`"${key}" is set by the platform and cannot be changed`, 400)
    }
    if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) {
      throw httpError(
        `value of "${key}" must be a string of at most ${MAX_VALUE_LENGTH} characters`,
        400,
      )
    }
    vars[key] = value
  }
  if (Object.keys(vars).length > MAX_VARS) {
    throw httpError(`at most ${MAX_VARS} variables`, 400)
  }
  return vars
}

const readNamespace = (sharedDir, name) =>
  ID_PATTERN.test(name)
    ? readJson(namespaceFile(sharedDir, name))
    : Promise.resolve(null)

const listNamespaces = async sharedDir => {
  const dir = path.join(sharedDir, 'env', 'namespaces')
  const names = await fsp.readdir(dir).catch(() => [])
  const all = []
  for (const file of names.filter(n => n.endsWith('.json'))) {
    const ns = await readJson(path.join(dir, file))
    if (ns) all.push(ns)
  }
  return all.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Creates a namespace or changes its variables. A namespace belongs to the AIT that created it.
 * `shared: true` lets apps of other AITs attach it too.
 * @param {string} sharedDir
 * @param {string} name
 * @param {{ ait?: string, shared?: boolean, set?: Record<string, string>, unset?: string[] }} changes
 */
const updateNamespace = async (sharedDir, name, { ait, shared, set, unset }) => {
  assertId(name, 'namespace')
  const existing = await readNamespace(sharedDir, name)
  if (existing && ait && existing.ait !== ait) {
    throw httpError(`namespace "${name}" belongs to another AIT`, 403)
  }
  if (!existing) assertId(ait, 'ait')
  const vars = applyChanges(existing ? existing.vars : {}, { set, unset })
  // the revision only moves when a value does, so saving without changes restarts nothing
  const changed = !existing || JSON.stringify(vars) !== JSON.stringify(existing.vars)
  const next = {
    name,
    ait: existing ? existing.ait : ait,
    shared: shared === undefined ? Boolean(existing && existing.shared) : Boolean(shared),
    vars,
    rev: (existing ? existing.rev : 0) + (changed ? 1 : 0),
    updatedAt: new Date().toISOString(),
  }
  await writeEnvFile(namespaceFile(sharedDir, name), next)
  return next
}

/** Apps that have `name` attached. */
const appsUsing = async (sharedDir, name) =>
  (await lifecycle.readRegistry(sharedDir))
    .filter(e => (e.envNamespaces || []).includes(name))
    .map(e => e.appId)

const deleteNamespace = async (sharedDir, name) => {
  assertId(name, 'namespace')
  if (!(await readNamespace(sharedDir, name))) {
    throw httpError(`No namespace "${name}"`, 404)
  }
  const users = await appsUsing(sharedDir, name)
  if (users.length) {
    throw httpError(`namespace "${name}" is used by: ${users.join(', ')}`, 409)
  }
  await fsp.rm(namespaceFile(sharedDir, name), { force: true })
}

const readAppVars = (sharedDir, appId) =>
  ID_PATTERN.test(appId)
    ? readJson(appFile(sharedDir, appId))
    : Promise.resolve(null)

/**
 * Changes the variables private to one app.
 * @param {string} sharedDir
 * @param {{ appId: string, ait: string }} app
 * @param {{ set?: Record<string, string>, unset?: string[] }} changes
 */
const updateAppVars = async (sharedDir, { appId, ait }, changes) => {
  assertId(appId, 'appId')
  const existing = await readAppVars(sharedDir, appId)
  const next = {
    appId,
    ait,
    vars: applyChanges(existing ? existing.vars : {}, changes),
    rev: (existing ? existing.rev : 0) + 1,
    updatedAt: new Date().toISOString(),
  }
  await writeEnvFile(appFile(sharedDir, appId), next)
  return next
}

const removeAppVars = (sharedDir, appId) =>
  ID_PATTERN.test(appId)
    ? fsp.rm(appFile(sharedDir, appId), { force: true })
    : Promise.resolve()

/**
 * The environment of an app: `vars` to start it with, and `hash`, a token that changes whenever
 * anything that feeds into `vars` is written. The hash is built from revision numbers, never from
 * values, so it can sit in the world-readable registry without leaking a secret.
 * `hash` is '' when the app has no variables, which is what registry entries from before this
 * feature carry. `missing` and `denied` name namespaces that are not there or belong to another AIT.
 */
const resolveEnv = async (sharedDir, { appId, ait, envNamespaces = [] }) => {
  const vars = {}
  const missing = []
  const denied = []
  const parts = []

  for (const name of envNamespaces) {
    const ns = await readNamespace(sharedDir, name)
    if (!ns) {
      missing.push(name)
      parts.push(`${name}:missing`)
    } else if (ns.ait !== ait && !ns.shared) {
      denied.push(name)
      parts.push(`${name}:denied`)
    } else {
      Object.assign(vars, ns.vars)
      parts.push(`${name}:${ns.rev}`)
    }
  }
  const own = await readAppVars(sharedDir, appId)
  if (own) {
    Object.assign(vars, own.vars)
    parts.push(`app:${own.rev}`)
  }
  for (const key of RESERVED) delete vars[key]

  const hash =
    parts.length === 0
      ? ''
      : crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)
  return { vars, hash, missing, denied }
}

/** Throws a 400 when an app is asked to attach a namespace that is missing or not allowed. */
const assertAttachable = async (sharedDir, { appId, ait, envNamespaces }) => {
  if (!Array.isArray(envNamespaces)) {
    throw httpError('namespaces must be a list', 400)
  }
  for (const name of envNamespaces) assertId(String(name), 'namespace')
  if (new Set(envNamespaces).size !== envNamespaces.length) {
    throw httpError('a namespace can only be attached once', 400)
  }
  const { missing, denied } = await resolveEnv(sharedDir, { appId, ait, envNamespaces })
  if (missing.length) throw httpError(`No namespace: ${missing.join(', ')}`, 404)
  if (denied.length) {
    throw httpError(
      `Namespace of another AIT, and not shared: ${denied.join(', ')}`,
      403,
    )
  }
}

module.exports = {
  RESERVED,
  applyChanges,
  readNamespace,
  listNamespaces,
  updateNamespace,
  deleteNamespace,
  appsUsing,
  readAppVars,
  updateAppVars,
  removeAppVars,
  resolveEnv,
  assertAttachable,
}
