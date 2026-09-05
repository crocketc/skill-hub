export const themeNames = [
  "moss-neutral",
  "spring-signal",
  "terracotta",
  "codex-light",
  "ocean-cobalt",
  "sakura",
  "aurora",
  "roast",
  "grok-night",
] as const;

export type ThemeName = (typeof themeNames)[number];
export type AppearancePreference = "system" | "light" | "dark" | ThemeName;

export const themePalettes: Record<ThemeName, readonly [string, string, string]> = {
  "moss-neutral": ["#eef0ec", "#3f7259", "#1c251f"],
  "spring-signal": ["#edf8f1", "#19a95b", "#15251b"],
  terracotta: ["#f5eee7", "#d7653b", "#2b1d16"],
  "codex-light": ["#f3f3f0", "#151614", "#171816"],
  "ocean-cobalt": ["#edf2fa", "#3d63d8", "#17243a"],
  sakura: ["#f8eff2", "#d45e88", "#311d25"],
  aurora: ["#f1effb", "#5952d6", "#211b3d"],
  roast: ["#f1ebe3", "#76513b", "#2d231c"],
  "grok-night": ["#090a0a", "#f2f3ef", "#f0f1ed"],
};

export function resolveTheme(
  preference: AppearancePreference,
  systemPrefersDark: boolean,
): ThemeName {
  if (preference === "system") {
    return systemPrefersDark ? "grok-night" : "moss-neutral";
  }

  if (preference === "light") {
    return "moss-neutral";
  }

  if (preference === "dark") {
    return "grok-night";
  }

  return preference;
}
