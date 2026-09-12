import type { ThemeName } from "./theme";
import { themeCss } from "./theme-css";

export type Tokens = Record<string, string>;

export function tokensFor(selector: string, occurrence: "first" | "last" = "first"): Tokens {
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

export function relativeLuminance(hex: string) {
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

export function contrast(foreground: string, background: string) {
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

export function tokensForThemeWithRootFallbacks(theme: ThemeName): Tokens {
  const tokens = { ...tokensFor(":root", "last") };
  if (theme === "grok-night") {
    Object.assign(tokens, tokensFor(`[data-theme="${theme}"]`, "last"));
  }
  // 主题自身块最后合并，保证主题内定义优先。
  return Object.assign(tokens, tokensFor(`[data-theme="${theme}"]`));
}

export function resolveTokenValue(
  value: string | undefined,
  tokens: Tokens,
  depth = 0,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const reference = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (!reference || depth > 4) {
    return value;
  }
  const next = tokens[reference[1].replace(/^--/, "")];
  return next ? resolveTokenValue(next, tokens, depth + 1) : undefined;
}

/** 把任意主题令牌值解析为六位 hex：支持 var() 引用链与 sRGB color-mix。 */
export function resolveTokenColor(
  value: string | undefined,
  tokens: Tokens,
  depth = 0,
): string | undefined {
  if (!value || depth > 6) {
    return undefined;
  }
  if (/^#[\da-fA-F]{6}$/.test(value)) {
    return value.toLowerCase();
  }
  const mix = value.match(/^color-mix\(\s*in\s+srgb,\s*(.+)\)\s*$/);
  if (mix) {
    // 顶层逗号切分（混合分量内不会再有函数）。
    const parts = mix[1].split(",").map((part) => part.trim());
    if (parts.length !== 2) {
      return undefined;
    }
    const components = parts.map((part) => {
      const withWeight = part.match(/^(.+?)\s+([\d.]+)%$/);
      return {
        token: withWeight ? withWeight[1].trim() : part,
        weight: withWeight ? Number.parseFloat(withWeight[2]) / 100 : undefined,
      };
    });
    const resolved = components.map((component) => ({
      color: resolveTokenColor(component.token, tokens, depth + 1),
      weight: component.weight,
    }));
    if (resolved.some((entry) => !entry.color)) {
      return undefined;
    }
    const weightA =
      resolved[0].weight ?? (resolved[1].weight !== undefined ? 1 - resolved[1].weight : 0.5);
    const weightB =
      resolved[1].weight ?? 1 - weightA;
    return mixHex(resolved[0].color!, resolved[1].color!, weightA, weightB);
  }
  const reference = value.match(/^var\(\s*--([\w-]+)\s*\)$/);
  if (reference) {
    return resolveTokenColor(tokens[reference[1]], tokens, depth + 1);
  }
  return undefined;
}

function mixHex(a: string, b: string, weightA: number, weightB: number): string {
  const channels = (hex: string) =>
    hex.slice(1).match(/.{2}/g)!.map((channel) => Number.parseInt(channel, 16));
  const [ra, ga, ba] = channels(a);
  const [rb, gb, bb] = channels(b);
  const total = weightA + weightB;
  const mixChannel = (x: number, y: number) =>
    Math.round((x * weightA + y * weightB) / total);
  const toHex = (channel: number) =>
    channel.toString(16).padStart(2, "0");
  return `#${toHex(mixChannel(ra, rb))}${toHex(mixChannel(ga, gb))}${toHex(
    mixChannel(ba, bb),
  )}`;
}
