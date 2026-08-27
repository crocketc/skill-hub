export type BuildTrust = "windows_signed" | "windows_unsigned" | "macos_signed" | "unknown";
export type NetworkSettings = { networkEnabled: boolean; llmProvider: string; dataScope: string };
export type AppUpdate = { version: string; notes: string; releaseUrl: string };
export type SettingsSnapshot = {
  network: NetworkSettings;
  appearance: { language: "zh-CN" | "en-US"; theme: string };
  library: { path: string; migrationAvailable: boolean };
  view: { density: "compact" | "standard" | "comfortable" };
  automation: { perSkill: boolean; batch: boolean; global: boolean };
  backup: { location: string; retentionDays: number };
  buildTrust: BuildTrust;
  update: AppUpdate | null;
};
export type SettingsCommand =
  | { type: "set_network_enabled"; payload: { enabled: boolean } }
  | { type: "set_theme"; payload: { theme: string } }
  | { type: "set_language"; payload: { language: SettingsSnapshot["appearance"]["language"] } }
  | { type: "set_library_path"; payload: { path: string } }
  | { type: "set_backup_location"; payload: { path: string } }
  | { type: "open_official_release" };
export interface SettingsFacade {
  execute(command: SettingsCommand): Promise<void>;
  get?: () => Promise<SettingsSnapshot>;
}
const unavailable = (operation: string): Promise<never> => Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
export const unavailableSettingsFacade: SettingsFacade = { execute: () => unavailable("settings_command"), get: () => unavailable("settings_query") };
export function networkSettings(): NetworkSettings { return { networkEnabled: true, llmProvider: "未配置", dataScope: "仅发送明确选择的内容" }; }
export function availableUpdate(): AppUpdate { return { version: "0.8.0", notes: "改进桌面端体验", releaseUrl: "https://github.com/crocketc/skill-hub/releases" }; }
export function settingsFixture(): SettingsSnapshot { return { network: networkSettings(), appearance: { language: "zh-CN", theme: "moss-neutral" }, library: { path: "C:/SkillHub/library", migrationAvailable: true }, view: { density: "compact" }, automation: { perSkill: true, batch: false, global: false }, backup: { location: "C:/SkillHub/backups", retentionDays: 30 }, buildTrust: "windows_unsigned", update: availableUpdate() }; }
