import { expect, test } from "@playwright/test";

test("first launch plays the welcome journey before the existing setup choices", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "languages", { configurable: true, get: () => ["zh-CN"] });
    Object.defineProperty(window, "isTauri", { configurable: true, value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
        transformCallback: () => 1,
        unregisterCallback: () => undefined,
        invoke: async (command: string, args: { query?: { type: string } }) => {
          if (command === "query_application" && args.query?.type === "get_bootstrap_snapshot") {
            return {
              type: "bootstrap_snapshot",
              payload: {
                initialization_state: "not_initialized",
                library_path: "",
                onboarding_skipped: false,
                agent_count: 0,
                discovered_agent_count: 0,
                deployed_count: 0,
                deployment_categories: [],
                tag_categories: [],
                last_scan_at: null,
                pending: { by_kind: {}, total: 0 },
                project_count: 0,
                recent_operations: [],
                recovery_state: "clean",
                skill_count: 0,
              },
            };
          }
          if (command === "query_application" && args.query?.type === "get_desktop_preferences") {
            return {
              type: "desktop_preferences",
              payload: {
                network_enabled: true,
                llm_provider: "",
                data_scope: "explicit_selection",
                language: "zh-CN",
                theme: "moss-neutral",
                density: "standard",
                automation_per_skill: false,
                automation_batch: false,
                automation_global: false,
                backup_location: "",
                backup_retention_days: 30,
              },
            };
          }
          return null;
        },
        convertFileSrc: (path: string) => path,
      },
    });
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      configurable: true,
      value: { unregisterListener: () => undefined },
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: /让每一项技能，\s*都有清晰的来路与去向/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "暂停动画" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "新建集中库" })).toHaveCount(0);

  await page.getByRole("button", { name: "开始设置" }).click();

  await expect(page).toHaveURL(/\/initialize$/);
  await expect(page.getByRole("button", { name: "新建集中库" })).toBeVisible();
  await expect(page.getByRole("button", { name: "使用已有集中库" })).toBeVisible();
  await expect(page.getByRole("button", { name: "从备份恢复" })).toBeVisible();
});
