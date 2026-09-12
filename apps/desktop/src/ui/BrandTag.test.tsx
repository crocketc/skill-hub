import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { brandIconSrc, BRAND_DISPLAY_NAMES, BRAND_ICON_FILES, BrandTag } from "./BrandTag";
import brandCss from "./BrandTag.css?raw";

it("renders known profile ids as their friendly brand names", () => {
  render(<BrandTag brand="openai" />);

  const tag = screen.getByText("OpenAI");
  expect(tag).toBeVisible();
  expect(tag).toHaveAttribute("title", "openai");
});

it("maps both claude and anthropic profile ids to the Claude brand", () => {
  render(
    <>
      <BrandTag brand="claude" />
      <BrandTag brand="anthropic" />
    </>,
  );

  expect(screen.getAllByText("Claude")).toHaveLength(2);
});

it("renders compound known ids with their catalog spelling", () => {
  render(<BrandTag brand="github-copilot" />);

  expect(screen.getByText("GitHub Copilot")).toBeVisible();
});

// M-30（验收反馈"Pi 与 DeepSeek Harness 缺少品牌 Logo"）：两个品牌现在
// 都有来自官方一手来源的图标，必须渲染真实素材而不是只有颜色标签。
it("renders Pi and DeepSeek Harness as known platform brands with official logos", () => {
  render(
    <>
      <BrandTag brand="pi" />
      <BrandTag brand="deepseek-harness" />
    </>,
  );

  expect(screen.getByText("Pi")).toHaveClass("sh-brand-tag--pi");
  expect(screen.getByText("DeepSeek Harness")).toHaveClass("sh-brand-tag--deepseek-harness");
  const tags = screen.getAllByText(/^(Pi|DeepSeek Harness)$/);
  expect(tags.map((tag) => tag.firstElementChild?.getAttribute("src"))).toEqual([
    "/brand/agents/lobehub/pi.svg",
    "/brand/agents/lobehub/deepseek-harness.svg",
  ]);
});

it("title-cases unknown brands while preserving the raw value in title", () => {
  render(<BrandTag brand="acme_robotics" />);

  const tag = screen.getByText("Acme Robotics");
  expect(tag).toHaveAttribute("title", "acme_robotics");
});

it("maps a profile id deterministically to one preset brand color class", () => {
  const first = render(<BrandTag brand="github-copilot" />);
  const firstTag = first.container.querySelector(".sh-brand-tag");
  expect(firstTag).toHaveClass("sh-brand-tag--github-copilot");
  expect(firstTag).not.toHaveClass("sh-brand-tag--neutral");

  const second = render(<BrandTag brand="GitHub Copilot" />);
  expect(second.container.querySelector(".sh-brand-tag")?.className).toBe(
    firstTag?.className,
  );
});

it("falls back to the neutral color class for unknown brands", () => {
  const { container } = render(<BrandTag brand="acme_robotics" />);

  expect(container.querySelector(".sh-brand-tag")).toHaveClass(
    "sh-brand-tag--neutral",
  );
});

// QA-014：已有素材的品牌必须用真实 Logo，未识别品牌保持颜色标签回退。

it("renders the bundled logo asset for known brands", () => {
  const { container } = render(<BrandTag brand="openai" />);

  const icon = container.querySelector(".sh-brand-tag__icon");
  expect(icon).toHaveAttribute("src", "/brand/agents/lobehub/openai.svg");
});

// P1-06（验收反馈"品牌图标再大一些"）：Logo 从 16px 放大到 20px，
// CSS 与 img 属性必须同步，避免样式漂移。
it("renders the brand logo at the enlarged 20px size", () => {
  const { container } = render(<BrandTag brand="openai" />);

  const icon = container.querySelector(".sh-brand-tag__icon");
  expect(icon).toHaveAttribute("width", "20");
  expect(icon).toHaveAttribute("height", "20");
  const rule = brandCss.match(/\.sh-brand-tag__icon\s*{([^}]*)}/);
  expect(rule?.[1]).toContain("1.25rem");
});

it("maps zcode to the zai logo asset", () => {
  const { container } = render(<BrandTag brand="zcode" />);

  expect(container.querySelector(".sh-brand-tag__icon")).toHaveAttribute(
    "src",
    "/brand/agents/lobehub/zai.svg",
  );
});

it("maps claude and hermes profile ids to their catalog logo assets", () => {
  const claude = render(<BrandTag brand="claude" />);
  expect(claude.container.querySelector(".sh-brand-tag__icon")).toHaveAttribute(
    "src",
    "/brand/agents/lobehub/anthropic.svg",
  );
  const hermes = render(<BrandTag brand="hermes" />);
  expect(hermes.container.querySelector(".sh-brand-tag__icon")).toHaveAttribute(
    "src",
    "/brand/agents/lobehub/hermes-agent.svg",
  );
});

it("keeps unknown brands on the neutral color tag without an invented logo", () => {
  const { container } = render(<BrandTag brand="acme_robotics" />);

  expect(container.querySelector(".sh-brand-tag__icon")).toBeNull();
  expect(screen.getByText("Acme Robotics")).toBeVisible();
  expect(container.querySelector(".sh-brand-tag")).toHaveClass("sh-brand-tag--neutral");
});

it("resolves every bundled agent logo through brandIconSrc", () => {
  expect(brandIconSrc("GitHub Copilot")).toBe(
    "/brand/agents/lobehub/github-copilot.svg",
  );
  expect(brandIconSrc("not-a-brand")).toBeNull();
});

it("covers every shipped lobehub asset with a mapping and vice versa", () => {
  // Vitest 以 apps/desktop 为工作目录，公共资源固定在 public/ 下。
  const assetDir = path.resolve(process.cwd(), "public/brand/agents/lobehub");
  const shipped = readdirSync(assetDir).filter((name) => name.endsWith(".svg")).sort();
  // M-30：pi.svg 与 deepseek-harness.svg 来自官方一手来源（SOURCES.md）。
  expect(shipped).toHaveLength(19);

  const mapped = [...new Set(Object.values(BRAND_ICON_FILES))].sort();
  expect(mapped).toEqual(shipped);
  for (const file of mapped) {
    expect(existsSync(path.join(assetDir, file))).toBe(true);
  }
});

// M-30：Pi 与 DeepSeek Harness 的图标是官方一手素材的逐字节拷贝；
// 与 assets/branding/ 下记录的原始下载件比对，防止后续被随机素材
// 静默替换（来源与许可证记录见 assets/branding/SOURCES.md）。
it("serves official Pi and DeepSeek Harness artwork byte for byte from the recorded masters", () => {
  const assetDir = path.resolve(process.cwd(), "public/brand/agents/lobehub");
  const brandingDir = path.resolve(process.cwd(), "../../assets/branding");
  const pairs: Array<[string, string]> = [
    ["pi.svg", "pi/pi-favicon.svg"],
    ["deepseek-harness.svg", "deepseek-harness/deepseek-harness-favicon.svg"],
  ];
  for (const [shippedName, masterName] of pairs) {
    const shippedPath = path.join(assetDir, shippedName);
    const masterPath = path.join(brandingDir, masterName);
    expect(existsSync(masterPath), `${masterName} master must be retained`).toBe(true);
    expect(readFileSync(shippedPath).equals(readFileSync(masterPath))).toBe(true);
  }
});

// P1-01c（QA-014 回归）：品牌芯片文字必须是同色系深色，且与浅色背景的
// 对比度达到 WCAG AA（≥4.5）。此前前景色误用边框浅色（≈1.2:1），导致
// 初始化流程中品牌 Logo 文字“都是灰色的，不清晰”。

type ChipTokens = { background?: string; border?: string; foreground?: string };

function relativeLuminance(hex: string) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) {
    throw new Error(`Expected a six-digit hex color, received ${hex}`);
  }
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/** 解析 BrandTag.css 默认（浅色）块中每个品牌类的三个 chip 变量。 */
function defaultBrandChipTokens(): Record<string, ChipTokens> {
  const tokens: Record<string, ChipTokens> = {};
  for (const match of brandCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (!selector.startsWith(".sh-brand-tag--")) continue;
    const body = match[2];
    const read = (name: string) =>
      body.match(new RegExp(`--brand-chip-${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    for (const rawClass of selector.split(",")) {
      const brand = rawClass.trim().match(/^\.sh-brand-tag--([\w-]+)$/)?.[1];
      if (!brand) continue;
      tokens[brand] = {
        background: read("background") ?? tokens[brand]?.background,
        border: read("border") ?? tokens[brand]?.border,
        foreground: read("foreground") ?? tokens[brand]?.foreground,
      };
    }
  }
  return tokens;
}

it("keeps every light-theme brand chip text at AA contrast on its own background", () => {
  const tokens = defaultBrandChipTokens();
  // 已知品牌目录（含 comate 这类无素材但有颜色标签的品牌）+ neutral。
  const expectedBrands = [...new Set([...Object.keys(BRAND_DISPLAY_NAMES), "neutral"])].sort();
  expect(Object.keys(tokens).sort(), "every known brand class defines chip colors").toEqual(
    expectedBrands,
  );

  for (const [brand, chip] of Object.entries(tokens)) {
    expect(chip.foreground, `${brand} defines a hex foreground`).toMatch(/^#/);
    expect(chip.background, `${brand} defines a hex background`).toMatch(/^#/);
    // 回归锁：前景不得再退回边框浅色。
    expect(chip.foreground, `${brand} foreground differs from its border pastel`).not.toBe(
      chip.border,
    );
    expect(
      contrastRatio(chip.foreground!, chip.background!),
      `${brand} chip text/background contrast`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});
