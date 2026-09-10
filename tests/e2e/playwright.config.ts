import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  // Keep the Vite preview server from competing with too many browser
  // workers; the startup budget is measured against this deterministic load.
  workers: 5,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "pnpm --dir apps/desktop exec vite --host 127.0.0.1 --port 5174 --strictPort",
    cwd: path.resolve(__dirname, "../.."),
    port: 5174,
    reuseExistingServer: false,
  },
});
