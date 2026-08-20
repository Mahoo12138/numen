import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@numen/config': fromRoot('./packages/config/src/index.ts'),
      '@numen/core': fromRoot('./packages/core/src/index.ts'),
      '@numen/database': fromRoot('./packages/database/src/index.ts'),
      '@numen/automation': fromRoot('./packages/automation/src/index.ts'),
      '@numen/scheduler': fromRoot('./packages/scheduler/src/index.ts'),
      '@numen/runtime': fromRoot('./packages/runtime/src/index.ts'),
      '@numen/workbench/runtime': fromRoot('./packages/workbench/src/runtime.ts'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.{ts,tsx}'],
    testTimeout: 15_000,
  },
})
