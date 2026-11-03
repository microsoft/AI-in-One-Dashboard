import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './browser-tests',
  testMatch: '**/*.e2e.mjs',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4317',
    browserName: 'chromium',
    channel: process.env.CI ? undefined : 'msedge',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: process.env.DEMO_PACKAGED ? 'node scripts/serve-bundles.mjs' : 'npm run preview -- --port 4317 --strictPort',
    url: `http://127.0.0.1:4317${process.env.DEMO_PACKAGED ? '/demo/ai-in-one/' : '/'}`,
    reuseExistingServer: false,
  },
})
