import { resolveTheme } from "./theme";

it("maps system appearance to neutral light and Grok dark", () => {
  expect(resolveTheme("system", false)).toBe("moss-neutral");
  expect(resolveTheme("system", true)).toBe("grok-night");
});

it("keeps a manually selected theme independent of system appearance", () => {
  expect(resolveTheme("codex-light", true)).toBe("codex-light");
  expect(resolveTheme("sakura", false)).toBe("sakura");
});

it("keeps the legacy light and dark choices available", () => {
  expect(resolveTheme("light", true)).toBe("moss-neutral");
  expect(resolveTheme("dark", false)).toBe("grok-night");
});
