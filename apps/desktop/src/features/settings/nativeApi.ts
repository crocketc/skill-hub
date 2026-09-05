import {
  executeCommand,
  queryApplication,
  type DesktopPreferences,
} from "../../api/bindings";
import {
  nativeApplicationUpdateOperations,
  type BuildTrust,
  type SettingsCommand,
  type SettingsFacade,
  type SettingsSnapshot,
} from "./api";
import { nativeBackupFacade } from "../backup/nativeApi";

const OFFICIAL_RELEASE_URL = "https://github.com/crocketc/skill-hub/releases";

function buildTrust(): BuildTrust {
  return navigator.userAgent.includes("Windows") ? "windows_unsigned" : "unknown";
}

function language(value: string): SettingsSnapshot["appearance"]["language"] {
  return value === "zh-CN" || value === "en-US" ? value : "system";
}

function density(value: string): SettingsSnapshot["view"]["density"] {
  return value === "compact" || value === "comfortable" ? value : "standard";
}

async function preferences(): Promise<DesktopPreferences> {
  const result = await queryApplication({ type: "get_desktop_preferences" });
  if (result.type !== "desktop_preferences") {
    throw new Error("get_desktop_preferences returned an unexpected native result.");
  }
  return result.payload;
}

async function save(command: SettingsCommand): Promise<void> {
  if (command.type === "open_official_release") {
    await executeCommand({
      type: "open_official_release",
      payload: { release_url: OFFICIAL_RELEASE_URL },
    });
    return;
  }
  if (command.type === "set_library_path") {
    throw new Error("Library migration must be completed through the initialization workflow.");
  }

  const current = await preferences();
  const next: DesktopPreferences = { ...current };
  switch (command.type) {
    case "set_network_enabled":
      next.network_enabled = command.payload.enabled;
      break;
    case "set_theme":
      next.theme = command.payload.theme;
      break;
    case "set_language":
      next.language = command.payload.language;
      break;
    case "set_density":
      next.density = command.payload.density;
      break;
    case "set_automation":
      next.automation_per_skill = command.payload.automation.perSkill;
      next.automation_batch = command.payload.automation.batch;
      next.automation_global = command.payload.automation.global;
      break;
    case "set_backup_location":
      next.backup_location = command.payload.path;
      break;
  }
  const result = await executeCommand({ type: "set_desktop_preferences", payload: next });
  if (result.type !== "desktop_preferences") {
    throw new Error("set_desktop_preferences returned an unexpected native result.");
  }
}

async function get(): Promise<SettingsSnapshot> {
  const [preferenceResult, bootstrap, updatePolicy] = await Promise.all([
    queryApplication({ type: "get_desktop_preferences" }),
    queryApplication({ type: "get_bootstrap_snapshot" }),
    queryApplication({ type: "get_application_update_policy" }),
  ]);
  if (preferenceResult.type !== "desktop_preferences") throw new Error("Desktop preferences are unavailable.");
  if (bootstrap.type !== "bootstrap_snapshot") throw new Error("Bootstrap settings facts are unavailable.");
  if (updatePolicy.type !== "application_update_policy") throw new Error("Update policy is unavailable.");
  const value = preferenceResult.payload;
  return {
    network: {
      networkEnabled: value.network_enabled,
      llmProvider: value.llm_provider,
      dataScope: value.data_scope,
    },
    appearance: { language: language(value.language), theme: value.theme },
    library: { path: bootstrap.payload.library_path, migrationAvailable: false },
    view: { density: density(value.density) },
    automation: {
      perSkill: value.automation_per_skill,
      batch: value.automation_batch,
      global: value.automation_global,
    },
    backup: { location: value.backup_location, retentionDays: value.backup_retention_days },
    buildTrust: buildTrust(),
    update: null,
    updateState: "not_checked",
    updatePolicy: {
      enabled: updatePolicy.payload.enabled,
      checkOnStartup: updatePolicy.payload.check_on_startup,
    },
  };
}

export const nativeSettingsFacade: SettingsFacade = {
  execute: save,
  get,
  backup: nativeBackupFacade,
  libraryHealth: {
    async runHealthCheck() {
      const result = await executeCommand({ type: "run_health_check", payload: null });
      if (result.type !== "health_report") {
        throw new Error("run_health_check returned an unexpected native result.");
      }
      return result.payload;
    },
    async listIgnoreRules() {
      const result = await queryApplication({ type: "list_ignore_rules" });
      if (result.type !== "ignore_rules") {
        throw new Error("list_ignore_rules returned an unexpected native result.");
      }
      return result.payload;
    },
    async createIgnoreRule(draft) {
      const result = await executeCommand({
        type: "create_ignore_rule",
        payload: { subject: draft.subject, reason: draft.reason, defer_until: draft.deferUntil },
      });
      if (result.type !== "ignore_rule") {
        throw new Error("create_ignore_rule returned an unexpected native result.");
      }
      return result.payload;
    },
    async removeIgnoreRule(ruleId) {
      const result = await executeCommand({ type: "remove_ignore_rule", payload: { rule_id: ruleId } });
      if (result.type !== "operation_summary") {
        throw new Error("remove_ignore_rule returned an unexpected native result.");
      }
    },
    async prepareRepair(healthReportId, findingIndex) {
      const result = await executeCommand({
        type: "prepare_repair",
        payload: { health_report_id: healthReportId, finding_index: findingIndex },
      });
      if (result.type !== "repair_plan") {
        throw new Error("prepare_repair returned an unexpected native result.");
      }
      return result.payload;
    },
    async commitRepair(repairId) {
      const result = await executeCommand({ type: "commit_repair", payload: { repair_id: repairId } });
      if (result.type !== "operation_summary") {
        throw new Error("commit_repair returned an unexpected native result.");
      }
      return result.payload;
    },
  },
  updates: nativeApplicationUpdateOperations({
    currentVersion: async () => (await import("@tauri-apps/api/app")).getVersion(),
    buildTrust,
  }),
};
