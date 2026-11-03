import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateProject } from '~utils/project'
import lifecycle from '../../runtime/lifecycle'

const run = promisify(execFile)

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/

export type PublishConfig = {
  sharedDir: string
  buildDir: string
  npmRegistry?: string
  portMin: number
  portMax: number
  vmName: string
  vmIp: string
  publicBaseUrl: string
}

export type RegistryEntry = {
  appId: string
  ait: string
  release: number
  vm: string
  ip: string
  port: number
  pid: number
  /** running, or what a user asked for (stopped, starting, deleting) until the owning VM has done it; failed if it cannot start */
  status: 'running' | 'stopped' | 'starting' | 'deleting' | 'failed'
  restarts?: number
  basePath: string
  updatedAt: string
}

export type PublishResult = {
  appId: string
  release: number
  /** Stable URL, served by the proxy through the registry */
  url: string
  /** Direct URL to the VM that runs the app */
  directUrl: string
  entry: RegistryEntry
}

// Everything environment-specific comes from env vars, so the same code runs on every VM.
export const loadConfig = (env = process.env): PublishConfig => ({
  sharedDir: env.SHARED_DIR || path.resolve('.shared'),
  buildDir: env.BUILD_DIR || path.join(os.tmpdir(), 'builder-builds'),
  npmRegistry: env.NPM_REGISTRY || undefined,
  portMin: Number(env.PORT_MIN || 20000),
  portMax: Number(env.PORT_MAX || 20999),
  vmName: env.VM_NAME || os.hostname(),
  vmIp: env.VM_IP || '127.0.0.1',
  publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
})

const inFlight = new Set<string>()

export class PublishError extends Error {
  constructor(message: string, public status = 500) {
    super(message)
  }
}

const nextRelease = async (appDir: string) => {
  const names = await fs.readdir(path.join(appDir, 'releases')).catch(() => [])
  return Math.max(0, ...names.map(Number).filter(Number.isInteger)) + 1
}

const writeFiles = async (dir: string, files: Record<string, string>) => {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
}

export const publish = async (
  components: IComponents,
  options: { appId: string; ait: string; name?: string },
  config = loadConfig(),
): Promise<PublishResult> => {
  const { appId, ait } = options
  if (!ID_PATTERN.test(appId) || !ID_PATTERN.test(ait)) {
    throw new PublishError(
      'appId and ait must be 3-40 chars: lowercase letters, digits, dashes',
      400,
    )
  }
  if (inFlight.has(appId)) {
    throw new PublishError(`${appId} is already being published`, 409)
  }
  inFlight.add(appId)

  try {
    const basePath = `/apps/${appId}`
    const appDir = path.join(config.sharedDir, 'apps', ait, appId)
    const release = await nextRelease(appDir)
    const releaseDir = path.join(appDir, 'releases', String(release))
    const buildDir = path.join(config.buildDir, appId, String(release))

    // install and build on local disk: thousands of small node_modules files are slow on NFS/EFS
    await fs.rm(buildDir, { recursive: true, force: true })
    await fs.mkdir(buildDir, { recursive: true })
    await writeFiles(
      buildDir,
      await generateProject(components, {
        name: options.name || appId,
        basePath,
        npmRegistry: config.npmRegistry,
      }),
    )
    // vite is a devDependency: install it even when the builder itself runs with NODE_ENV=production
    await run('npm', ['install', '--include=dev', '--no-audit', '--no-fund'], {
      cwd: buildDir,
    })
    await run('npm', ['run', 'build'], {
      cwd: buildDir,
      env: { ...process.env, BASE_PATH: basePath },
    })

    // the shared release holds only what is needed to run: no node_modules
    await fs.mkdir(releaseDir, { recursive: true })
    for (const name of [
      'dist',
      'server.js',
      'package.json',
      'package-lock.json',
      '.env.build',
    ]) {
      await fs.cp(path.join(buildDir, name), path.join(releaseDir, name), {
        recursive: true,
      })
    }
    await fs.rm(buildDir, { recursive: true, force: true })

    const registry: RegistryEntry[] = await lifecycle.readRegistry(
      config.sharedDir,
    )
    const claimed = registry
      .filter(e => e.vm === config.vmName)
      .map(e => e.port)

    let port: number
    try {
      port = await lifecycle.allocatePort(config, claimed)
    } catch (e) {
      throw new PublishError((e as Error).message + ` on ${config.vmName}`, 503)
    }

    const pid: number = lifecycle.startApp({ releaseDir, port, basePath })
    try {
      await lifecycle.waitHealthy('127.0.0.1', port)
    } catch (e) {
      lifecycle.stopProcess(pid)
      throw new PublishError((e as Error).message, 502)
    }

    // switch over only after the new release is healthy, then stop the old process on this VM
    const previous = registry.find(e => e.appId === appId)
    const entry: RegistryEntry = {
      appId,
      ait,
      release,
      vm: config.vmName,
      ip: config.vmIp,
      port,
      pid,
      status: 'running',
      basePath,
      updatedAt: new Date().toISOString(),
    }
    await lifecycle.writeRegistry(config.sharedDir, entry)
    if (previous && previous.vm === config.vmName) {
      lifecycle.stopProcess(previous.pid)
    }

    return {
      appId,
      release,
      url: `${config.publicBaseUrl}${basePath}/`,
      directUrl: `http://${config.vmIp}:${port}${basePath}/`,
      entry,
    }
  } catch (e) {
    if (e instanceof PublishError) throw e
    const detail = (e as { stderr?: string }).stderr || (e as Error).message
    throw new PublishError(`Publish failed: ${detail}`.slice(0, 2000))
  } finally {
    inFlight.delete(appId)
  }
}
