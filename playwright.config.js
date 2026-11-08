// Browser tests. They run the site in local mode against the local Supabase,
// never production.
//
//   npx supabase start        (once per session; Docker must be running)
//   npx supabase db reset     (fresh test data from supabase/seed.sql)
//   npm run test:e2e          (headless)   or   npm run test:e2e:ui (watch it run)

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // tests share one seeded database
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:8000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/build.mjs --serve --local',
    url: 'http://localhost:8000/index.html',
    reuseExistingServer: true,
    timeout: 30_000,
  },
  globalSetup: './tests/e2e/global-setup.js',
});
