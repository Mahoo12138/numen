import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const artifacts = JSON.parse(await readFile(join(root, 'artifacts/npm/manifest.json'), 'utf8'))
const directory = await mkdtemp(join(tmpdir(), 'numen-npm-consumer-'))
const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
try {
  for (const item of artifacts) {
    const archive = await readFile(join(root, 'artifacts/npm', item.filename))
    if (createHash('sha256').update(archive).digest('hex') !== item.sha256) throw new Error(`Archive integrity mismatch: ${item.name}`)
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'numen-external-consumer', private: true, type: 'module',
    dependencies: {
      ...Object.fromEntries(artifacts.map(item => [item.name, `file:${join(root, 'artifacts/npm', item.filename)}`])),
      vue: '^3.5.0', '@vue/server-renderer': '^3.5.0', cordis: '4.0.0-rc.8',
      typescript: rootPackage.devDependencies.typescript, '@types/node': rootPackage.devDependencies['@types/node'],
      vite: rootPackage.devDependencies.vite,
    },
  }, null, 2))
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit' })
  await writeFile(join(directory, 'consumer.ts'), `
import { h, createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { Button, SelectMenu, StringLiteralEditor, FormSection, type SchemaField } from '@numenjs/components'
import { numenPluginRuntime } from '@numenjs/components/vite'
import { BrowserExtensionRegistry, SchemaUIRegistry } from '@numenjs/webui'
import { ConsoleEntryRegistry } from '@numenjs/console'
import { Context } from 'cordis'
import { isNumenValue } from '@numenjs/core'
const field: SchemaField = { name: 'message', label: 'Message', type: 'string', schemaType: 'string', required: true }
const html = await renderToString(createSSRApp({ render: () => h(FormSection, { title: 'Settings' }, () => [
  h(Button, { onClick() {} }, () => 'Save'),
  h(SelectMenu, { ariaLabel: 'Mode', value: 'a', options: [{ value: 'a', label: 'Alpha' }], onChange() {} }),
  h(StringLiteralEditor, { canEdit: true, controlId: 'test', inputId: 'input', invalid: false, field, onCommit() {} }),
]) }))
if (!html.includes('Alpha') || !html.includes('Required') || !html.includes('Save')) throw new Error('Installed component render failed')
if (numenPluginRuntime().name !== 'numen-plugin-runtime') throw new Error('Missing plugin build adapter')
if (!isNumenValue({ nested: [1, true, null] }) || isNumenValue(Infinity)) throw new Error('Installed core contract failed')
const root = new Context()
await root.plugin(ConsoleEntryRegistry)
await root.plugin(BrowserExtensionRegistry)
await root.plugin(SchemaUIRegistry)
await root.fiber.dispose()
console.log('Installed npm packages: type declarations, ESM/SSR, build adapter, and Cordis services verified.')
`)
  execFileSync(process.execPath, [join(directory, 'node_modules/typescript/bin/tsc'), 'consumer.ts', '--outDir', 'dist', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--target', 'ES2023', '--strict', '--skipLibCheck'], { cwd: directory, stdio: 'inherit' })
  execFileSync(process.execPath, ['dist/consumer.js'], { cwd: directory, stdio: 'inherit' })
  // A real production consumer must also get distributable CSS and tree-shakable Vue ESM.
  await writeFile(join(directory, 'index.html'), '<div id="app"></div><script type="module" src="/app.js"></script>')
  await writeFile(join(directory, 'app.js'), `import { createApp, h } from 'vue'; import { Button } from '@numenjs/components'; import '@numenjs/components/style.css'; createApp({ render: () => h(Button, {}, () => 'Installed') }).mount('#app')`)
  execFileSync(process.execPath, [join(directory, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: directory, stdio: 'inherit' })
  await writeFile(join(directory, 'plugin.js'), `export { Button } from '@numenjs/components'; export { ref } from 'vue'; export { Context } from 'cordis'; import '@numenjs/components/style.css'`)
  await writeFile(join(directory, 'vite.config.js'), `import { numenPluginRuntime } from '@numenjs/components/vite'; export default { plugins: [numenPluginRuntime()], build: { outDir: 'plugin-dist', lib: { entry: 'plugin.js', formats: ['es'], fileName: () => 'plugin.js' } } }`)
  execFileSync(process.execPath, [join(directory, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: directory, stdio: 'inherit' })
  const plugin = await readFile(join(directory, 'plugin-dist/plugin.js'), 'utf8')
  for (const module of ['vue', 'cordis', 'components']) {
    if (!plugin.includes(`/workbench/${module}.js`)) throw new Error(`Plugin did not share host ${module}`)
  }
  if (plugin.length > 2_000) throw new Error('Plugin unexpectedly bundled a runtime')

} finally {
  await rm(directory, { recursive: true, force: true })
}
