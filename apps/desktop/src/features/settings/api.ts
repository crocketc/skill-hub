import { executeCommand, queryApplication, type UpdateArtifact, type UpdateManifest, type UpdatePlatform } from "../../api/bindings";

export type BuildTrust = "windows_signed" | "windows_unsigned" | "macos_signed" | "unknown";
export type NetworkSettings = { networkEnabled: boolean; llmProvider: string; dataScope: string };
export type AppUpdate = {
  version: string;
  notes: string;
  releaseUrl: string;
  assetName?: string | null;
  assetUrl?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  manifest?: UpdateManifest | null;
  platform?: UpdatePlatform | null;
};
export type UpdateState =
  | "not_checked"
  | "checking"
  | "up_to_date"
  | "available"
  | "downloading"
  | "verifying"
  | "ready_to_install"
  | "failed"
  | "rolled_back";
export type UpdatePolicy = { enabled: boolean; checkOnStartup: boolean };
export type UpdateProgress = { receivedBytes: number; totalBytes: number | null } | null;
export type SettingsSnapshot = {
  network: NetworkSettings;
  appearance: { language: "system" | "zh-CN" | "en-US"; theme: string };
  library: { path: string; migrationAvailable: boolean };
  view: { density: "compact" | "standard" | "comfortable" };
  automation: { perSkill: boolean; batch: boolean; global: boolean };
  backup: { location: string; retentionDays: number };
  buildTrust: BuildTrust;
  update: AppUpdate | null;
  updateState: UpdateState;
  updatePolicy: UpdatePolicy;
};
export type SettingsCommand =
  | { type: "set_network_enabled"; payload: { enabled: boolean } }
  | { type: "set_theme"; payload: { theme: string } }
  | { type: "set_language"; payload: { language: SettingsSnapshot["appearance"]["language"] } }
  | { type: "set_library_path"; payload: { path: string } }
  | { type: "set_backup_location"; payload: { path: string } }
  | { type: "open_official_release" };
/**
 * Drives the application update state machine behind the settings card.
 * Tests and preview inject fakes; production binds these to the typed
 * Tauri commands and queries without any GitHub access inside components.
 */
export interface ApplicationUpdateOperations {
  check(): Promise<AppUpdate | null>;
  download(): Promise<void>;
  install(): Promise<void>;
  cancel(): Promise<void>;
  rollback(): Promise<void>;
}
export interface SettingsFacade {
  execute(command: SettingsCommand): Promise<void>;
  get?: () => Promise<SettingsSnapshot>;
  updates?: ApplicationUpdateOperations;
}
const unavailable = (operation: string): Promise<never> => Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
export const unavailableSettingsFacade: SettingsFacade = { execute: () => unavailable("settings_command"), get: () => unavailable("settings_query") };
export function networkSettings(): NetworkSettings { return { networkEnabled: true, llmProvider: "未配置", dataScope: "仅发送明确选择的内容" }; }
export function availableUpdate(): AppUpdate { return { version: "0.8.0", notes: "改进桌面端体验", releaseUrl: "https://github.com/crocketc/skill-hub/releases", assetName: "SkillHub_0.8.0_x64.nsis.zip", assetUrl: "https://github.com/crocketc/skill-hub/releases/download/v0.8.0/SkillHub_0.8.0_x64.nsis.zip", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", sizeBytes: 1048576 }; }
export function settingsFixture(): SettingsSnapshot { return { network: networkSettings(), appearance: { language: "zh-CN", theme: "moss-neutral" }, library: { path: "C:/SkillHub/library", migrationAvailable: true }, view: { density: "compact" }, automation: { perSkill: true, batch: false, global: false }, backup: { location: "C:/SkillHub/backups", retentionDays: 30 }, buildTrust: "windows_unsigned", update: availableUpdate(), updateState: "available", updatePolicy: { enabled: true, checkOnStartup: true } }; }

const OFFICIAL_UPDATE_REPOSITORY = "crocketc/skill-hub";

export type UpdateErrorKey =
  | "errors.unavailable"
  | "errors.integrity_failed"
  | "errors.signature_missing"
  | "errors.signature_invalid"
  | "errors.invalid_artifact_url"
  | "errors.download_cancelled"
  | "errors.install_blocked"
  | "errors.network_disabled"
  | "errors.rate_limited"
  | "errors.generic";

const UPDATE_ERROR_KEYS: Record<string, UpdateErrorKey> = {
  "application_update.unavailable": "errors.unavailable",
  "application_update.integrity_failed": "errors.integrity_failed",
  "application_update.signature_missing": "errors.signature_missing",
  "application_update.signature_invalid": "errors.signature_invalid",
  "application_update.invalid_artifact_url": "errors.invalid_artifact_url",
  "application_update.download_cancelled": "errors.download_cancelled",
  "application_update.install_blocked": "errors.install_blocked",
  "network.disabled": "errors.network_disabled",
  "source.search_rate_limited": "errors.rate_limited",
};

export function updateErrorKey(errorCode: string | null | undefined): UpdateErrorKey {
  if (!errorCode) return "errors.generic";
  return UPDATE_ERROR_KEYS[errorCode] ?? "errors.generic";
}

export function errorCodeOf(reason: unknown): string | null {
  if (reason && typeof reason === "object" && "code" in reason && typeof (reason as { code: unknown }).code === "string") {
    return (reason as { code: string }).code;
  }
  return null;
}

function unavailableOperation(operation: string): Promise<never> {
  return Promise.reject(new Error(`${operation} is unavailable until the native contract is added.`));
}

/** Binds the update card to the typed native update contracts. */
export function nativeApplicationUpdateOperations(input: {
  currentVersion: () => Promise<string>;
  buildTrust: () => BuildTrust;
}): ApplicationUpdateOperations {
  const nativeTrust = (trust: BuildTrust) => {
    switch (trust) {
      case "windows_signed":
        return "windows_trusted" as const;
      case "macos_signed":
        return "macos_notarized" as const;
      default:
        return "unknown" as const;
    }
  };
  let checkedManifest: UpdateManifest | null = null;
  let checkedPlatform: UpdatePlatform | null = null;
  let preparedArtifact: UpdateArtifact | null = null;

  return {
    async check() {
      const currentVersion = await input.currentVersion();
      const facts = await queryApplication({
        type: "check_application_update",
        payload: {
          current_version: currentVersion,
          repository: OFFICIAL_UPDATE_REPOSITORY,
          build_trust: nativeTrust(input.buildTrust()),
        },
      });
      if (facts.type !== "application_update") return null;
      const result = facts.payload;
      if (!result.available) {
        checkedManifest = null;
        checkedPlatform = null;
        preparedArtifact = null;
        return null;
      }
      checkedManifest = result.manifest ?? null;
      checkedPlatform = result.platform ?? null;
      preparedArtifact = null;
      const expectedTarget = checkedPlatform
        ? `${checkedPlatform.target}-${checkedPlatform.arch}`
        : null;
      const selectedArtifact = checkedManifest?.artifacts.find(
        (candidate) => candidate.target === expectedTarget,
      );
      return {
        version: result.latest_version,
        notes: checkedManifest?.notes ?? "",
        releaseUrl: result.release_url,
        assetName: selectedArtifact?.url.split("/").pop() ?? result.asset_name,
        assetUrl: selectedArtifact?.url ?? null,
        sha256: selectedArtifact?.sha256 ?? null,
        sizeBytes: selectedArtifact ? Number(selectedArtifact.size) : null,
        manifest: checkedManifest,
        platform: checkedPlatform,
      };
    },
    async download() {
      if (!checkedManifest || !checkedPlatform) {
        throw new Error("download_application_update is unavailable until a signed update manifest is checked.");
      }
      const currentVersion = await input.currentVersion();
      const prepared = await executeCommand({
        type: "prepare_application_update",
        payload: {
          current_version: currentVersion,
          manifest: checkedManifest,
          platform: checkedPlatform,
        },
      });
      if (prepared.type !== "prepared_application_update") {
        throw new Error("prepare_application_update returned an unexpected result.");
      }
      preparedArtifact = prepared.payload.artifact;
      const downloaded = await executeCommand({
        type: "download_application_update",
        payload: { artifact: preparedArtifact },
      });
      if (downloaded.type !== "downloaded_application_update") {
        throw new Error("download_application_update returned an unexpected result.");
      }
    },
    async install() {
      const result = await executeCommand({ type: "install_application_update", payload: null });
      if (result.type !== "application_update_state") {
        throw new Error("install_application_update returned an unexpected result.");
      }
    },
    async cancel() {
      await unavailableOperation("cancel_download");
    },
    async rollback() {
      const result = await executeCommand({ type: "rollback_application_update", payload: null });
      if (result.type !== "application_update_state") {
        throw new Error("rollback_application_update returned an unexpected result.");
      }
    },
  };
}
