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
