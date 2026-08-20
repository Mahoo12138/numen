import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  base: '/workbench/',
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
