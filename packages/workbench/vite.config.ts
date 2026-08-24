import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import vueJsx from '@vitejs/plugin-vue-jsx'

const publicBase = '/workbench/'

function shareWorkbenchRuntime(): Plugin {
  return {
    name: 'numen-share-workbench-runtime',
    generateBundle(_options, bundle) {
      const entry = bundle['core-entry.js']
      if (!entry || entry.type !== 'chunk') throw new Error('Workbench core Entry output was not generated')
      for (const imported of entry.imports) {
        const relative = `./${imported}`
        const shared = `${publicBase}${imported}`
        entry.code = entry.code.replaceAll(`"${relative}"`, `"${shared}"`)
        entry.code = entry.code.replaceAll(`'${relative}'`, `'${shared}'`)
        if (entry.code.includes(relative)) {
          throw new Error(`Workbench core Entry contains an unshared runtime import: ${relative}`)
        }
      }
    },
  }
}

export default defineConfig({
  base: publicBase,
  plugins: [vueJsx(), shareWorkbenchRuntime()],
  build: {
    outDir: 'dist/app',
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        'core-entry': fileURLToPath(new URL('./src/entry.ts', import.meta.url)),
      },
      output: {
        entryFileNames: chunk => chunk.name === 'core-entry'
          ? 'core-entry.js'
          : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
})
