import { fileURLToPath } from 'node:url'
import vueJsx from '@vitejs/plugin-vue-jsx'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  plugins: [vueJsx()],
  resolve: {
    alias: {
      '@numenjs/components/style.css': fromRoot('./packages/components/src/style.css'),
      '@numenjs/components/vite': fromRoot('./packages/components/src/vite.ts'),
      '@numenjs/components': fromRoot('./packages/components/src/index.ts'),
      '@numenjs/logging/contracts': fromRoot('./packages/logging/src/contracts.ts'),
      '@numenjs/logging/config': fromRoot('./packages/logging/src/config.ts'),
      '@numenjs/logging': fromRoot('./packages/logging/src/index.ts'),
      '@numenjs/i18n': fromRoot('./packages/i18n/src/index.ts'),
      '@numenjs/config': fromRoot('./packages/config/src/index.ts'),
      '@numenjs/core': fromRoot('./packages/core/src/index.ts'),
      '@numenjs/database': fromRoot('./packages/database/src/index.ts'),
      '@numenjs/credentials': fromRoot('./packages/credentials/src/index.ts'),
      '@numenjs/automation': fromRoot('./packages/automation/src/index.ts'),
      '@numenjs/scheduler': fromRoot('./packages/scheduler/src/index.ts'),
      '@numenjs/runtime': fromRoot('./packages/runtime/src/index.ts'),
      '@numenjs/workbench/runtime': fromRoot('./packages/workbench/src/runtime.ts'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.{ts,tsx}'],
    testTimeout: 15_000,
  },
})
