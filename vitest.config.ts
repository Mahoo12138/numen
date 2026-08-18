import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@numen/config': fromRoot('./packages/config/src/index.ts'),
      '@numen/core': fromRoot('./packages/core/src/index.ts'),
      '@numen/database': fromRoot('./packages/database/src/index.ts'),
      '@numen/runtime': fromRoot('./packages/runtime/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    testTimeout: 15_000,
  },
})
