import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: '*.bench.ts', fullyParallel: false, workers: 1,
  timeout: 240_000, expect: { timeout: 15_000 }, reporter: 'line',
  outputDir: process.env.NUMEN_BENCH_OUTPUT ?? '/tmp/numen-workbench-benchmark',
  use: { headless: true, viewport: { width: 1440, height: 960 }, locale: 'en-US',
    screenshot: 'only-on-failure', trace: 'off', launchOptions: { args: ['--enable-precise-memory-info'] } },
})
