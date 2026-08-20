import { defineConfig } from 'vite'

export default defineConfig({
  base: '/workbench/',
  build: {
    outDir: 'dist/app',
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
})
