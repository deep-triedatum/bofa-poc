import { generateCode } from '~utils/code'

export type ProjectFiles = Record<string, string>

export type ProjectOptions = {
  /** npm package name of the generated app */
  name: string
  /** URL prefix the app is served under, e.g. `/apps/<appId>`. Applied at build time. */
  basePath?: string
  /** Private registry (Artifactory) written to the generated `.npmrc`. Omit to use npm's default. */
  npmRegistry?: string
}

const DEFAULT_BASE_PATH = '/'

const packageJson = (name: string) =>
  JSON.stringify(
    {
      name,
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        start: 'node server.js',
      },
      dependencies: {
        '@chakra-ui/icons': '^2.0.9',
        '@chakra-ui/react': '^2.3.2',
        '@chakra-ui/theme': '^2.1.11',
        '@emotion/react': '^11.10.4',
        '@emotion/styled': '^11.10.4',
        'framer-motion': '7.3.0',
        react: '^18.2.0',
        'react-dom': '^18.2.0',
      },
      devDependencies: {
        '@vitejs/plugin-react': '^4.2.1',
        vite: '^5.2.0',
      },
    },
    null,
    2,
  )

// base comes from the environment so the generated code never changes between deployments
const viteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: process.env.BASE_PATH || '${DEFAULT_BASE_PATH}',
  plugins: [react()],
})
`

const indexHtml = (name: string) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`

const mainJsx = `import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')).render(<App />)
`

// Dependency-free static server: PORT and BASE_PATH are read at start-up, never baked into the build.
const serverJs = `import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist')
const port = Number(process.env.PORT)
const base = (process.env.BASE_PATH || '/').replace(/\\/+$/, '')
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

if (!port) {
  console.error('PORT is required')
  process.exit(1)
}

http
  .createServer((req, res) => {
    if (req.url === '/healthz') return res.end('ok')
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (base && rel.startsWith(base)) rel = rel.slice(base.length)
    let file = path.join(dist, path.normalize(rel))
    if (!file.startsWith(dist)) { res.statusCode = 403; return res.end() }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html')
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream')
    fs.createReadStream(file).pipe(res)
  })
  .listen(port, () => console.log('listening on ' + port))
`

const npmrc = (registry?: string) =>
  registry
    ? `registry=${registry}\nfund=false\naudit=false\n`
    : `fund=false\naudit=false\n`

/**
 * Turns the editor's component tree into the files of a runnable Vite + React project.
 * The caller writes the returned map to disk, runs `npm install` + `npm run build`,
 * then starts the app with `PORT=<port> BASE_PATH=<basePath> npm start`.
 */
export const generateProject = async (
  components: IComponents,
  { name, basePath, npmRegistry }: ProjectOptions,
): Promise<ProjectFiles> => {
  const appCode = await generateCode(components)

  return {
    'package.json': packageJson(name),
    '.npmrc': npmrc(npmRegistry),
    'vite.config.js': viteConfig,
    'index.html': indexHtml(name),
    'server.js': serverJs,
    'src/main.jsx': mainJsx,
    'src/App.jsx': appCode,
    // read by the deployer, not by the app itself
    '.env.build': `BASE_PATH=${basePath || DEFAULT_BASE_PATH}\n`,
  }
}
