import { normalizeBrandKey } from "./BrandTag";

// Colored marks use a representative hue from the bundled logo assets.
// Monochrome marks use neutral gray, visible on both light and dark canvases.
// Claude uses the terracotta family already used by its brand presentation.
const brandChartColors: Record<string, string> = {
  anthropic: "#C47755",
  claude: "#C47755",
  codebuddy: "#6C4DFF",
  codex: "#3941FF",
  gemini: "#3186FF",
  google: "#3186FF",
  kimi: "#1783FF",
  openclaw: "#FF4D4D",
  qoder: "#2ADB5C",
  trae: "#32F08C",
};

export function brandChartColor(brand: string): string {
  return brandChartColors[normalizeBrandKey(brand)] ?? "#777777";
}
