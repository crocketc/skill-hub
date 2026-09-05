import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { nativeSettingsFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({ executeCommand: vi.fn(), queryApplication: vi.fn() }));

const query = vi.mocked(queryApplication);
const execute = vi.mocked(executeCommand);

const preferences = {
  network_enabled: true,
  llm_provider: "local-model",
  data_scope: "explicit_selection",
  language: "en-US",
  theme: "moss-neutral",
  density: "compact",
  automation_per_skill: true,
  automation_batch: false,
  automation_global: false,
  backup_location: "D:/SkillHub/backups",
  backup_retention_days: 14,
};

beforeEach(() => {
  query.mockReset();
  execute.mockReset();
});

it("composes the settings page from persisted preferences and native bootstrap facts", async () => {
  query
    .mockResolvedValueOnce({ type: "desktop_preferences", payload: preferences })
    .mockResolvedValueOnce({
      type: "bootstrap_snapshot",
      payload: {
        initialization_state: "initialized",
        library_path: "D:/SkillHub/library",
        onboarding_skipped: false,
        agent_count: 0,
        deployed_count: 0,
        deployment_categories: [],
        last_scan_at: null,
        pending: { by_kind: {}, total: 0 },
        project_count: 0,
        recent_operations: [],
        recovery_state: "clean",
        skill_count: 0,
      },
    })
    .mockResolvedValueOnce({
      type: "application_update_policy",
      payload: { enabled: true, check_on_startup: false },
    });

  await expect(nativeSettingsFacade.get?.()).resolves.toEqual(expect.objectContaining({
    network: { networkEnabled: true, llmProvider: "local-model", dataScope: "explicit_selection" },
    appearance: { language: "en-US", theme: "moss-neutral" },
    library: { path: "D:/SkillHub/library", migrationAvailable: false },
    view: { density: "compact" },
    backup: { location: "D:/SkillHub/backups", retentionDays: 14 },
    updatePolicy: { enabled: true, checkOnStartup: false },
  }));
});

it("persists the network switch without replacing unrelated preferences", async () => {
  query.mockResolvedValue({ type: "desktop_preferences", payload: preferences });
  execute.mockResolvedValue({
    type: "desktop_preferences",
    payload: { ...preferences, network_enabled: false },
  });

  await nativeSettingsFacade.execute({ type: "set_network_enabled", payload: { enabled: false } });

  expect(execute).toHaveBeenCalledWith({
    type: "set_desktop_preferences",
    payload: { ...preferences, network_enabled: false },
  });
});

it("persists view density and automation choices without replacing unrelated preferences", async () => {
  query.mockResolvedValue({ type: "desktop_preferences", payload: preferences });
  execute.mockResolvedValue({ type: "desktop_preferences", payload: { ...preferences, density: "comfortable", automation_batch: true } });

  await nativeSettingsFacade.execute({ type: "set_density", payload: { density: "comfortable" } });
  await nativeSettingsFacade.execute({ type: "set_automation", payload: { automation: { perSkill: true, batch: true, global: false } } });

  expect(execute).toHaveBeenNthCalledWith(1, { type: "set_desktop_preferences", payload: { ...preferences, density: "comfortable" } });
  expect(execute).toHaveBeenNthCalledWith(2, { type: "set_desktop_preferences", payload: { ...preferences, automation_per_skill: true, automation_batch: true, automation_global: false } });
});
