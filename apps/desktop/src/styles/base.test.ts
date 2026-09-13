import { describe, expect, it } from "vitest";
import baseCss from "./base.css?raw";
import { themeNames } from "./theme";
import {
  contrast,
  resolveTokenColor,
  tokensForThemeWithRootFallbacks,
} from "./theme.test-utils";

type Tokens = Record<string, string>;

/** 取 base.css 中指定选择器的声明块（按 "selector {" 精确匹配）。 */
function declarationsFor(selector: string): Tokens {
  const start = baseCss.indexOf(`\n${selector} {`);
  if (start < 0) {
    throw new Error(`Missing selector in base.css: ${selector}`);
  }
  const blockStart = baseCss.indexOf("{", start);
  const blockEnd = baseCss.indexOf("}", blockStart);
  const block = baseCss.slice(blockStart + 1, blockEnd);
  const declarations: Tokens = {};
  for (const declaration of block.split(";")) {
    const match = declaration.match(/^\s*(-{0,2}[A-Za-z][\w-]*)\s*:\s*([\s\S]+)$/);
    if (match) {
      declarations[match[1]] = match[2].trim();
    }
  }
  return declarations;
}

function rawBlockFor(selector: string): string {
  const start = baseCss.indexOf(`\n${selector} {`);
  expect(start, `base.css defines ${selector}`).toBeGreaterThanOrEqual(0);
  const blockStart = baseCss.indexOf("{", start);
  const blockEnd = baseCss.indexOf("}", blockStart);
  return baseCss.slice(blockStart, blockEnd);
}

describe("sidebar collapse control states", () => {
  // 验收反馈：折叠按钮重新设计为 codex 桌面风格的方形安静控件，
  // 五个状态（安静 / 悬停 / 按下 / 键盘焦点 / 折叠态）语义 token 化，
  // 去掉悬浮阴影一类的营销式装饰。D5 起控件迁入一体化标题栏
  // （topbar-start 首位），视觉契约值原样迁移到新选择器。
  it("styles the quiet state with square semantic control tokens and no drop shadow", () => {
    const declarations = declarationsFor(".sh-app-shell__sidebar-toggle");
    // M-17-1 验收反馈要求折叠控件收窄为 28px 方形安静控件。
    expect(declarations["width"]).toBe("1.75rem");
    expect(declarations["height"]).toBe("1.75rem");
    expect(declarations["border-radius"]).toBe("var(--radius-sm)");
    expect(declarations["border"]).toBe("1px solid var(--ui-border)");
    expect(declarations["background"]).toBe("var(--ui-control-background)");
    expect(declarations["color"]).toBe("var(--ui-icon-muted)");
    expect(rawBlockFor(".sh-app-shell__sidebar-toggle")).not.toContain("box-shadow");
  });

  it("gives hover, pressed, focus and collapsed states distinct semantic styling", () => {
    const hover = declarationsFor(".sh-app-shell__sidebar-toggle:hover");
    expect(hover["background"]).toBe("var(--ui-hover-surface)");
    expect(hover["color"]).toBe("var(--ui-ink)");

    const pressed = declarationsFor(".sh-app-shell__sidebar-toggle:active");
    expect(pressed["background"]).toBe("var(--ui-pressed-surface)");

    expect(rawBlockFor(".sh-app-shell__sidebar-toggle:focus-visible")).toContain(
      "var(--ui-focus)",
    );

    const collapsed = declarationsFor(
      '.sh-app-shell__sidebar-toggle[aria-expanded="false"]',
    );
    expect(collapsed["background"]).toBe("var(--ui-surface-subtle)");
    expect(collapsed["color"]).toBe("var(--ui-ink)");
  });

  it("keeps the control at 28px in the compact narrow title-bar row", () => {
    const mediaStart = baseCss.indexOf("@media");
    const toggleStart = baseCss.indexOf(".sh-app-shell__sidebar-toggle", mediaStart);
    const blockEnd = baseCss.indexOf(".sh-sidebar nav", toggleStart);
    expect(toggleStart, "compact row restyles the toggle").toBeGreaterThan(0);
    const compactBlock = baseCss.slice(toggleStart, blockEnd);
    expect(compactBlock).toContain("width: 1.75rem");
    expect(compactBlock).toContain("height: 1.75rem");
    expect(compactBlock).not.toContain("box-shadow");
  });
});

describe("unified title bar shell layout", () => {
  // D5：壳层改为纵向 grid——标题栏行 + 主体行；侧栏与 workspace 排在
  // 主体行内，沿用 --sidebar-width 变量机制（含折叠变体）。
  it("arranges a title-bar row over a sidebar/workspace body row", () => {
    const shell = declarationsFor(".sh-app-shell");
    expect(shell["display"]).toBe("grid");
    expect(shell["grid-template-rows"]).toBe("auto minmax(0, 1fr)");

    const body = declarationsFor(".sh-app-shell__body");
    expect(body["display"]).toBe("grid");
    expect(body["grid-template-columns"]).toBe(
      "var(--sidebar-width) minmax(0, 1fr)",
    );

    expect(declarationsFor(".sh-app-shell__topbar-context")["display"]).toBe("flex");
  });

  it("reserves macOS traffic-light clearance in the title bar and sidebar header", () => {
    expect(
      declarationsFor(".sh-is-macos .sh-app-shell__topbar-start")["padding-left"],
    ).toBe("5rem");
    expect(declarationsFor(".sh-is-macos .sh-sidebar__header")["padding-left"]).toBe(
      "5rem",
    );
  });

  it("drops the retired sidebar-resident toggle and query-tools layout rules", () => {
    expect(baseCss).not.toContain(".sh-sidebar__toggle");
    expect(baseCss).not.toContain(".sh-skill-library__query-tools > section");
  });
});

describe("sidebar collapse control contrast across the nine themes", () => {
  // 图形控件按 WCAG 1.4.11 非文本对比度要求 3:1；焦点环保留同样的下限。
  it.each(themeNames)(
    "keeps every toggle state visible in %s",
    (theme) => {
      const tokens = tokensForThemeWithRootFallbacks(theme);
      const resolve = (token: string) => {
        const value = resolveTokenColor(tokens[token], tokens);
        expect(value, `${theme} --${token} resolves to a hex color`).toMatch(/^#/);
        return value as string;
      };

      expect(contrast(resolve("ui-icon-muted"), resolve("ui-control-background"))).toBeGreaterThanOrEqual(3);
      expect(contrast(resolve("ui-ink"), resolve("ui-hover-surface"))).toBeGreaterThanOrEqual(3);
      expect(contrast(resolve("ui-ink"), resolve("ui-pressed-surface"))).toBeGreaterThanOrEqual(3);
      expect(contrast(resolve("ui-ink"), resolve("ui-surface-subtle"))).toBeGreaterThanOrEqual(3);
      expect(contrast(resolve("ui-focus"), resolve("ui-canvas"))).toBeGreaterThanOrEqual(3);
    },
  );
});

it("keeps the detail notification bell clear of the content scrollbar", () => {
  expect(rawBlockFor(".sh-app-shell__detail-notifications")).toContain(
    "right: calc(var(--space-4) + var(--space-3))",
  );
});
