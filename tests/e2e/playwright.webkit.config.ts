import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/** Opt-in Safari/WebKit regression lane for platform-specific scrolling behavior. */
export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5176",
    trace: "retain-on-failure",
    ...devices["Desktop Safari"],
  },
  webServer: {
    command: "pnpm --dir apps/desktop exec vite --host 127.0.0.1 --port 5176 --strictPort",
    cwd: path.resolve(__dirname, "../.."),
    port: 5176,
    reuseExistingServer: false,
  },
});
