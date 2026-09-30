const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'android-chromium',
      use: {
        ...devices['Pixel 5'],
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {
          launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        } : {})
      }
    },
    { name: 'iphone-webkit', use: { ...devices['iPhone 13'] } }
  ],
  webServer: {
    command: 'python3 tests/server.py',
    url: 'http://127.0.0.1:8080',
    reuseExistingServer: !process.env.CI
  }
});
