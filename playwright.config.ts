import { defineConfig } from "@playwright/test";

// In the Nix dev shell this points at nixpkgs' chromium; otherwise Playwright's own.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    viewport: { width: 1400, height: 900 },
    launchOptions: { executablePath },
    trace: "retain-on-failure",
  },
});
