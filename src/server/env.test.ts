/**
 * @jest-environment node
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import lifecycle from '../../runtime/lifecycle'
import envStore from '../../runtime/env'
import {
  deleteNamespace,
  getAppEnv,
  getNamespace,
  listNamespaces,
  saveAppEnv,
  saveNamespace,
} from './env'
import { PublishConfig, RegistryEntry } from './publisher'

let shared: string
let config: PublishConfig

const entryFor = (
  appId: string,
  extra: Partial<RegistryEntry> = {},
): RegistryEntry => ({
  appId,
  ait: 'ait-1',
  release: 1,
  vm: 'vm-a',
  ip: '127.0.0.1',
  port: 24100,
  pid: 999999,
  status: 'running',
  basePath: `/apps/${appId}`,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

beforeAll(() => {
  shared = fs.mkdtempSync(path.join(os.tmpdir(), 'env-api-test-'))
  config = {
    sharedDir: shared,
    buildDir: path.join(shared, 'build'),
    portMin: 24000,
    portMax: 24999,
    vmName: 'vm-a',
    vmIp: '127.0.0.1',
    publicBaseUrl: '',
  }
})
afterAll(() => fs.rmSync(shared, { recursive: true, force: true }))

test('lists names of variables, never values', async () => {
  await saveNamespace(
    'payments',
    { ait: 'ait-1', set: { API_URL: 'https://x', TOKEN: 'hunter2' } },
    config,
  )
  const [ns] = await listNamespaces({}, config)
  expect(ns).toMatchObject({
    name: 'payments',
    ait: 'ait-1',
    keys: ['API_URL', 'TOKEN'],
  })
  expect(JSON.stringify(await getNamespace('payments', config))).not.toContain(
    'hunter2',
  )
})

test('two apps attach one namespace and see the same variables', async () => {
  await lifecycle.writeRegistry(shared, entryFor('app-one'))
  await lifecycle.writeRegistry(shared, entryFor('app-two'))

  const one = await saveAppEnv(
    'app-one',
    { namespaces: ['payments'], set: { OWN: '1' } },
    config,
  )
  const two = await saveAppEnv('app-two', { namespaces: ['payments'] }, config)

  expect(one.effectiveKeys).toEqual(['API_URL', 'OWN', 'TOKEN'])
  expect(two.effectiveKeys).toEqual(['API_URL', 'TOKEN'])
  expect(one.keys).toEqual(['OWN'])
  expect((await getNamespace('payments', config)).usedBy).toEqual([
    'app-one',
    'app-two',
  ])
})

test('a change is not applied until the owning VM restarts the app', async () => {
  const before = await getAppEnv('app-two', config)
  expect(before.applied).toBe(false) // the registry entry was written without a hash

  // what the owning VM's reconciler does after restarting the app
  const entry = await lifecycle.readEntry(shared, 'app-two')
  const { hash } = await envStore.resolveEnv(shared, entry)
  await lifecycle.writeRegistry(shared, { ...entry, envHash: hash })
  expect((await getAppEnv('app-two', config)).applied).toBe(true)

  await saveNamespace('payments', { set: { TOKEN: 'rotated' } }, config)
  expect((await getAppEnv('app-two', config)).applied).toBe(false)
})

test('refuses unknown, foreign and reserved names', async () => {
  await expect(
    saveAppEnv('app-one', { namespaces: ['nope-ns'] }, config),
  ).rejects.toMatchObject({ status: 404 })
  await saveNamespace('other-ait', { ait: 'ait-2', set: { A: '1' } }, config)
  await expect(
    saveAppEnv('app-one', { namespaces: ['other-ait'] }, config),
  ).rejects.toMatchObject({ status: 403 })
  await expect(
    saveAppEnv('app-one', { set: { PORT: '1' } }, config),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    saveAppEnv('missing-app', { set: { A: '1' } }, config),
  ).rejects.toMatchObject({ status: 404 })
})

test('lists only what an AIT can attach: its own and shared ones', async () => {
  const names = async (ait: string) =>
    (await listNamespaces({ ait }, config)).map(n => n.name)
  expect(await names('ait-1')).toEqual(['payments'])
  await saveNamespace('other-ait', { shared: true }, config)
  expect(await names('ait-1')).toEqual(['other-ait', 'payments'])
})

test('a namespace in use cannot be deleted, and can once it is detached', async () => {
  await expect(deleteNamespace('payments', config)).rejects.toMatchObject({
    status: 409,
  })
  await saveAppEnv('app-one', { namespaces: [] }, config)
  await saveAppEnv('app-two', { namespaces: [] }, config)
  await deleteNamespace('payments', config)
  await expect(getNamespace('payments', config)).rejects.toMatchObject({
    status: 404,
  })
})
