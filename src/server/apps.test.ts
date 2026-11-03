/**
 * @jest-environment node
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import lifecycle from '../../runtime/lifecycle'
import { deleteApp, listApps, startApp, stopApp } from './apps'
import { PublishConfig, RegistryEntry } from './publisher'

const FAKE_SERVER = `require('node:http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT))\n`

let shared: string
let config: PublishConfig
const started: number[] = []

const entryFor = (
  appId: string,
  extra: Partial<RegistryEntry> = {},
): RegistryEntry => ({
  appId,
  ait: 'ait-1',
  release: 1,
  vm: 'vm-a',
  ip: '127.0.0.1',
  port: 24000,
  pid: 999999,
  status: 'running',
  basePath: `/apps/${appId}`,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

const releaseDir = (e: RegistryEntry) =>
  path.join(shared, 'apps', e.ait, e.appId, 'releases', String(e.release))

// a really running app, so stopping it can be observed
const runApp = async (
  appId: string,
  port: number,
  extra: Partial<RegistryEntry> = {},
) => {
  const e = entryFor(appId, { port, ...extra })
  fs.mkdirSync(releaseDir(e), { recursive: true })
  fs.writeFileSync(path.join(releaseDir(e), 'server.js'), FAKE_SERVER)
  const pid: number = lifecycle.startApp({
    releaseDir: releaseDir(e),
    port,
    basePath: e.basePath,
  })
  started.push(pid)
  await lifecycle.waitHealthy('127.0.0.1', port)
  await lifecycle.writeRegistry(shared, { ...e, pid })
  return { ...e, pid }
}

const read = (appId: string): Promise<RegistryEntry | null> =>
  lifecycle.readEntry(shared, appId)

const answers = (port: number) => lifecycle.probe('127.0.0.1', port, 300)
const gone = async (port: number) => {
  for (let i = 0; i < 20; i++) {
    if (!(await answers(port))) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

beforeAll(() => {
  shared = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-test-'))
  config = {
    sharedDir: shared,
    buildDir: path.join(shared, 'builds'),
    portMin: 24000,
    portMax: 24100,
    vmName: 'vm-a',
    vmIp: '127.0.0.1',
    publicBaseUrl: 'http://lb.test',
  }
})

afterAll(() => {
  started.forEach(pid => lifecycle.stopProcess(pid))
  fs.rmSync(shared, { recursive: true, force: true })
})

describe('listApps', () => {
  it('lists apps with their stable URL and health, filtered by AIT', async () => {
    await runApp('list-one', 24001)
    await lifecycle.writeRegistry(
      shared,
      entryFor('list-two', { ait: 'ait-2', status: 'stopped', port: 24002 }),
    )

    const all = await listApps({}, config)
    const one = all.find(a => a.appId === 'list-one')!
    expect(one.healthy).toBe(true)
    expect(one.url).toBe('http://lb.test/apps/list-one/')
    expect(all.find(a => a.appId === 'list-two')!.healthy).toBe(false)

    const filtered = await listApps({ ait: 'ait-2' }, config)
    expect(filtered.map(a => a.appId)).toEqual(['list-two'])
  })
})

describe('stopApp', () => {
  it('stops the process of an app on this VM and marks it stopped', async () => {
    await runApp('stop-local', 24010)

    await stopApp('stop-local', config)

    expect(await gone(24010)).toBe(true)
    expect((await read('stop-local'))!.status).toBe('stopped')
  })

  it('only marks an app on another VM; that VM stops the process', async () => {
    await runApp('stop-remote', 24011, { vm: 'vm-b' })

    await stopApp('stop-remote', config)

    expect(await answers(24011)).toBe(true)
    expect((await read('stop-remote'))!.status).toBe('stopped')
  })

  it('rejects unknown apps and ids that are not valid', async () => {
    await expect(stopApp('no-such-app', config)).rejects.toMatchObject({
      status: 404,
    })
    await expect(stopApp('../registry/x', config)).rejects.toMatchObject({
      status: 400,
    })
  })
})

describe('startApp', () => {
  it('asks for a stopped app to be started', async () => {
    await lifecycle.writeRegistry(
      shared,
      entryFor('start-it', { status: 'stopped' }),
    )
    await startApp('start-it', config)
    expect((await read('start-it'))!.status).toBe('starting')
  })

  it('leaves a running app alone', async () => {
    const before = entryFor('already-up')
    await lifecycle.writeRegistry(shared, before)
    await startApp('already-up', config)
    expect(await read('already-up')).toEqual(before)
  })

  it('refuses an app that is being deleted', async () => {
    await lifecycle.writeRegistry(
      shared,
      entryFor('going-away', { status: 'deleting' }),
    )
    await expect(startApp('going-away', config)).rejects.toMatchObject({
      status: 409,
    })
  })
})

describe('deleteApp', () => {
  it('removes the process, releases and registry entry of an app on this VM', async () => {
    const e = await runApp('delete-local', 24020)

    expect(await deleteApp('delete-local', config)).toEqual({ deleted: true })

    expect(await gone(24020)).toBe(true)
    expect(await read('delete-local')).toBeNull()
    expect(fs.existsSync(path.join(shared, 'apps', e.ait, e.appId))).toBe(false)
  })

  it('marks an app on another VM as deleting and leaves its files for that VM', async () => {
    const e = await runApp('delete-remote', 24021, { vm: 'vm-b' })

    expect(await deleteApp('delete-remote', config)).toEqual({ deleted: false })

    expect((await read('delete-remote'))!.status).toBe('deleting')
    expect(fs.existsSync(releaseDir(e))).toBe(true)
    expect(await answers(24021)).toBe(true)
  })
})
