import { resolveTheme } from "./theme";
import { themeNames, themePalettes } from "./theme";
import {
  contrast,
  resolveTokenValue,
  tokensFor,
  tokensForThemeWithRootFallbacks,
} from "./theme.test-utils";

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

it.each(themeNames)("keeps %s text and semantic states at AA contrast", (theme) => {
  const tokens = tokensFor(`[data-theme="${theme}"]`);
  const rootTokens = tokensFor(":root", "last");

  for (const foreground of ["color-text", "color-text-secondary", "color-text-muted"]) {
    for (const background of ["color-page", "color-surface"]) {
      expect(
        contrast(tokens[foreground], tokens[background]),
        `${theme} ${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }

  for (const background of ["color-page", "color-surface"]) {
    expect(
      contrast(tokens["color-focus"], tokens[background]),
      `${theme} focus ring on ${background}`,
    ).toBeGreaterThanOrEqual(3);
  }

  const accentFillColors =
    tokens["color-accent-fill"].match(/#[\da-f]{6}/gi) ?? [tokens["color-accent"]];
  for (const accentFill of accentFillColors) {
    expect(
      contrast(tokens["color-on-accent"], accentFill),
      `${theme} accent button on ${accentFill}`,
    ).toBeGreaterThanOrEqual(4.5);
  }

  const semanticTokens =
    theme === "grok-night"
      ? {
          ...rootTokens,
          ...tokensFor(`[data-theme="${theme}"]`, "last"),
        }
      : rootTokens;
  for (const status of ["success", "warning", "danger", "info"]) {
    expect(
      contrast(
        semanticTokens[`color-${status}`],
        semanticTokens[`color-${status}-soft`],
      ),
      `${theme} ${status} status`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

/** 设计规格 3.2：全部主题必须暴露的语义角色 token。 */
const uiSemanticTokens = [
  "ui-canvas",
  "ui-surface",
  "ui-surface-subtle",
  "ui-ink",
  "ui-ink-muted",
  "ui-accent",
  "ui-border-subtle",
  "ui-border",
  "ui-border-strong",
  "ui-control-background",
  "ui-control-border",
  "ui-control-border-hover",
  "ui-control-placeholder",
  "ui-hover-surface",
  "ui-pressed-surface",
  "ui-selected-surface",
  "ui-selected-border",
  "ui-disabled-background",
  "ui-disabled-text",
  "ui-disabled-border",
  "ui-icon",
  "ui-icon-muted",
  "ui-icon-on-accent",
  "ui-focus",
  "ui-success-foreground",
  "ui-success-background",
  "ui-success-border",
  "ui-on-success",
  "ui-warning-foreground",
  "ui-warning-background",
  "ui-warning-border",
  "ui-on-warning",
  "ui-danger-foreground",
  "ui-danger-background",
  "ui-danger-border",
  "ui-on-danger",
  "ui-info-foreground",
  "ui-info-background",
  "ui-info-border",
  "ui-on-info",
] as const;

const statusRoles = ["success", "warning", "danger", "info"] as const;

it("locks the nine preset theme names and their order", () => {
  expect([...themeNames]).toEqual([
    "moss-neutral",
    "spring-signal",
    "terracotta",
    "codex-light",
    "ocean-cobalt",
    "sakura",
    "aurora",
    "roast",
    "grok-night",
  ]);
});

it.each(themeNames)(
  "exposes every semantic ui role token inside %s",
  (theme) => {
    const tokens = tokensFor(`[data-theme="${theme}"]`);
    for (const token of uiSemanticTokens) {
      expect(tokens[token], `${theme} defines --${token}`).toBeTruthy();
    }
  },
);

it.each(themeNames)(
  "keeps %s canvas and accent identity aligned with its registered palette",
  (theme) => {
    const tokens = tokensForThemeWithRootFallbacks(theme);
    expect(resolveTokenValue(tokens["ui-canvas"], tokens)).toBe(
      themePalettes[theme][0],
    );
    expect(resolveTokenValue(tokens["ui-accent"], tokens)).toBe(
      themePalettes[theme][1],
    );
  },
);

it.each(themeNames)(
  "keeps %s inverse status text readable on solid status colors",
  (theme) => {
    const tokens = tokensForThemeWithRootFallbacks(theme);
    for (const status of statusRoles) {
      const foreground = resolveTokenValue(
        tokens[`ui-${status}-foreground`],
        tokens,
      );
      const inverse = resolveTokenValue(tokens[`ui-on-${status}`], tokens);
      expect(foreground, `${theme} ui-${status}-foreground`).toMatch(/^#/);
      expect(inverse, `${theme} ui-on-${status}`).toMatch(/^#/);
      expect(
        contrast(inverse as string, foreground as string),
        `${theme} ui-on-${status} on ${status}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  },
);

it("keeps the legacy color variables usable as compatibility aliases", () => {
  const rootTokens = {
    ...tokensFor(":root", "first"),
    ...tokensFor(":root", "last"),
  };
  for (const token of ["color-text-primary", "color-border-subtle", "color-border-strong"]) {
    expect(rootTokens[token], `--${token} is defined`).toBeTruthy();
  }
});

// P2-01：页面级留白节奏 token——页头与正文区块之间的 section gap。概览
// （PageFrame）、设置、发现三页共用同一档，不允许页面各自内联一档间距。
const pageRhythmTokens = ["page-gap"] as const;

it.each(pageRhythmTokens)("defines the shared page rhythm token --%s", (token) => {
  const rootTokens = {
    ...tokensFor(":root", "first"),
    ...tokensFor(":root", "last"),
  };
  expect(rootTokens[token], `--${token} is defined for every theme`).toBeTruthy();
});

it("keeps the page rhythm on the unified 1rem section-gap step", () => {
  const rootTokens = {
    ...tokensFor(":root", "first"),
    ...tokensFor(":root", "last"),
  };
  expect(rootTokens["page-gap"], "--page-gap must alias the space-4 step").toBe(
    "var(--space-4)",
  );
});

it("keeps the radius ladder on the 4/6/10/14px design-spec steps", () => {
  const rootTokens = {
    ...tokensFor(":root", "first"),
    ...tokensFor(":root", "last"),
  };
  expect(rootTokens["radius-xs"], "--radius-xs (labels)").toBe("0.25rem");
  expect(rootTokens["radius-sm"], "--radius-sm (inputs and buttons)").toBe("0.375rem");
  expect(rootTokens["radius-md"], "--radius-md (entity cards)").toBe("0.625rem");
  expect(rootTokens["radius-lg"], "--radius-lg (drawers and dialogs)").toBe("0.875rem");
});

it.each(themeNames)(
  "exposes a stronger accent step for %s so hover states stay themed",
  (theme) => {
    const tokens = tokensFor(`[data-theme="${theme}"]`);
    expect(tokens["ui-accent-strong"], `${theme} defines --ui-accent-strong`).toBeTruthy();
  },
);
