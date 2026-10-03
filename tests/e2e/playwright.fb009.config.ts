import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5175", trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: {
    command: "pnpm --dir apps/desktop exec vite --host 127.0.0.1 --port 5175 --strictPort",
    cwd: path.resolve(__dirname, "../.."),
    port: 5175,
    reuseExistingServer: true,
  },
});
