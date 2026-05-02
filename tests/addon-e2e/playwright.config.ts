import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './.generated',
  timeout: 30_000,
  retries: 1,
  workers: 1,
  reporter: [
    ['html', { outputFolder: './reports/html', open: 'never' }],
    ['json', { outputFile: './reports/results.json' }],
  ],
  use: {
    baseURL: process.env.PICLAW_E2E_URL || 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'desktop-safari', use: { ...devices['Desktop Safari'] } },
    { name: 'ipad', use: { ...devices['iPad Pro 11'] } },
    { name: 'iphone', use: { ...devices['iPhone 14 Pro'] } },
  ],
});
