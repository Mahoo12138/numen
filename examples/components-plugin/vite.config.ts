import { defineConfig } from 'vite'
import vueJsx from '@vitejs/plugin-vue-jsx'
import { numenPluginRuntime } from '@numenjs/components/vite'

export default defineConfig({
  plugins: [vueJsx(), numenPluginRuntime()],
  build: {
    emptyOutDir: false,
    lib: { entry: 'src/client.tsx', formats: ['es'], fileName: () => 'client.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
