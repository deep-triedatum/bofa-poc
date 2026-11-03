import { generateProject } from './project'

const components: IComponents = {
  root: {
    id: 'root',
    parent: 'root',
    type: 'Box',
    children: ['comp-1'],
    props: {},
  },
  'comp-1': {
    id: 'comp-1',
    parent: 'root',
    type: 'Text',
    children: [],
    props: { children: 'Hello bank' },
  },
}

describe('generateProject', () => {
  it('emits the files of a runnable Vite project', async () => {
    const files = await generateProject(components, { name: 'demo-app' })

    expect(Object.keys(files).sort()).toEqual(
      [
        '.env.build',
        '.npmrc',
        'index.html',
        'package.json',
        'server.js',
        'src/App.jsx',
        'src/main.jsx',
        'vite.config.js',
      ].sort(),
    )
    expect(files['src/App.jsx']).toContain('Hello bank')
    expect(JSON.parse(files['package.json']).name).toBe('demo-app')
  })

  it('keeps basePath and registry out of the generated code', async () => {
    const files = await generateProject(components, {
      name: 'demo-app',
      basePath: '/apps/abc',
      npmRegistry: 'https://artifactory.example/api/npm/npm-virtual/',
    })

    expect(files['.env.build']).toBe('BASE_PATH=/apps/abc\n')
    expect(files['.npmrc']).toContain('registry=https://artifactory.example')
    expect(files['src/App.jsx']).not.toContain('/apps/abc')
    expect(files['vite.config.js']).toContain('process.env.BASE_PATH')
  })
})
