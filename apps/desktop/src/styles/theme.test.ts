import { resolveTheme } from "./theme";
import { themeNames } from "./theme";
import themeCss from "./theme.css?raw";

type Tokens = Record<string, string>;

function tokensFor(selector: string, occurrence: "first" | "last" = "first"): Tokens {
  const themeName = selector.match(/data-theme=["']([^"']+)["']/)?.[1];
  const needle = themeName ?? selector;
  const selectorIndex =
    occurrence === "first"
      ? themeCss.indexOf(needle)
      : themeCss.lastIndexOf(needle);
  const blockStart = themeCss.indexOf("{", selectorIndex);
  const blockEnd = themeCss.indexOf("}", blockStart);
  if (selectorIndex < 0 || blockStart < 0 || blockEnd < 0) {
    throw new Error(`Missing theme block: ${selector}`);
  }

  const block = themeCss.slice(blockStart + 1, blockEnd);

  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((entry) => [
      entry[1],
      entry[2].trim(),
    ]),
  );
}

function relativeLuminance(hex: string) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) {
    throw new Error(`Expected a six-digit hex color, received ${hex}`);
  }

  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string) {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

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
