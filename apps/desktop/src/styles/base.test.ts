import { describe, expect, it } from "vitest";
import baseCss from "./base.css?raw";
import themeCss from "./theme.css?raw";
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
  it("uses the shared borderless icon-button geometry", () => {
    const declarations = declarationsFor(".sh-sidebar__toggle");
    expect(declarations["width"]).toBe("2.5rem");
    expect(declarations["height"]).toBe("2.5rem");
    expect(declarations["border"]).toBe("0");
    expect(declarations["background"]).toBe("transparent");
    expect(rawBlockFor(".sh-sidebar__toggle")).not.toContain("box-shadow");
  });

  it("keeps the expanded logo prominent and aligns the toggle with the topbar", () => {
    const logo = declarationsFor(".sh-sidebar__brand .sh-brand-logo");
    expect(logo["height"]).toBe("2.75rem");
    expect(logo["transform"]).toBe("translateY(var(--space-2))");

    const toggle = declarationsFor(".sh-sidebar__toggle");
    expect(toggle["inset-inline-start"]).toBe("calc(-1 * var(--space-2))");
    expect(toggle["top"]).toBe("calc(50% - var(--space-4))");
  });

  it("keeps the topbar compact at 3rem and centers its controls", () => {
    const topbar = declarationsFor(".sh-app-shell__topbar");
    expect(topbar["min-height"]).toBe("var(--topbar-height)");
    expect(topbar["align-items"]).toBe("center");
    expect(themeCss).toMatch(/--topbar-height:\s*3rem;/);
  });

  it("moves the compact brand to the content title bar in collapsed mode", () => {
    expect(baseCss).toMatch(/\.sh-app-shell__compact-brand\s*\{/);
    expect(baseCss).toMatch(/\.sh-app-shell__compact-brand[^{]*\.sh-brand-logo/);
    expect(declarationsFor(".sh-app-shell__compact-brand")["margin-inline-end"]).toBe(
      "var(--space-2)",
    );
  });

  it("keeps the narrow-screen sidebar header controls in normal flow", () => {
    const narrowScreen = baseCss.slice(baseCss.indexOf("@media (max-width: 24rem)"));
    expect(narrowScreen).toMatch(/\.sh-sidebar__header\s*\{[\s\S]*?display:\s*flex;/);
    expect(narrowScreen).toMatch(/\.sh-sidebar__brand\s*\{[\s\S]*?position:\s*static;/);
    expect(narrowScreen).toMatch(/\.sh-sidebar__toggle\s*\{[\s\S]*?position:\s*static;/);
  });
});

describe("unified title bar shell layout", () => {
  it("arranges a full-height sidebar beside a content title-bar workspace", () => {
    const shell = declarationsFor(".sh-app-shell");
    expect(shell["display"]).toBe("grid");
    expect(shell["grid-template-columns"]).toBe(
      "var(--sidebar-width) minmax(0, 1fr)",
    );

    expect(declarationsFor(".sh-app-shell__topbar-context")["display"]).toBe("flex");
  });

  it("matches the collapsed sidebar width to the compact title-bar height", () => {
    expect(declarationsFor(".sh-app-shell.is-sidebar-collapsed")["--sidebar-width"]).toBe(
      "var(--topbar-height)",
    );
    expect(
      declarationsFor(".sh-app-shell.is-sidebar-collapsed .sh-sidebar")["padding-inline"],
    ).toBe("0");
    expect(
      declarationsFor(".sh-app-shell.is-sidebar-collapsed .sh-sidebar__toggle")[
        "inset-inline-start"
      ],
    ).toBe("calc(var(--space-2) - var(--space-1))");
    expect(
      declarationsFor(".sh-app-shell.is-sidebar-collapsed .sh-sidebar__scroll")[
        "scrollbar-gutter"
      ],
    ).toBe("auto");
  });

  it("reserves macOS traffic-light clearance in the title bar and sidebar header", () => {
    expect(
      declarationsFor(".sh-is-macos .sh-sidebar__header")["padding-left"],
    ).toBe("5rem");
    expect(
      declarationsFor(".sh-is-macos .sh-sidebar__toggle")["top"],
    ).toBe("calc(50% - var(--space-4) + var(--space-6))");
  });

  it("keeps the macOS collapsed topbar start free of extra compensation", () => {
    // OPT-20260914-04：macOS 收起态左排不再叠加 5rem 补偿；Logo 起点由
    // 收起侧栏 3rem + 顶栏自身 1.25rem（--space-5）内边距构成，Windows 布局不受影响。
    expect(
      baseCss.includes(
        ".sh-is-macos .sh-app-shell.is-sidebar-collapsed .sh-app-shell__topbar-start",
      ),
    ).toBe(false);
    expect(declarationsFor(".sh-app-shell__topbar")["padding-inline"]).toBe(
      "var(--space-5)",
    );
    expect(themeCss).toMatch(/--space-5:\s*1\.25rem;/);
  });

  it("drops the retired sidebar-resident toggle and query-tools layout rules", () => {
    // 遗留风险清理（2026-09-14）：query-tools 仅存的元素级残留选择器
    // （input/select/button 与活类并组）也拆分删除，base.css 不再有痕迹。
    expect(baseCss).not.toContain("query-tools");
  });
});

describe("macOS expanded sidebar vertical rhythm", () => {
  it("lowers the expanded logo and primary navigation by one extra space step on macOS", () => {
    // macOS 展开态反馈：大 Logo 与导航页签整体偏上。在既有全平台 8px Logo 位移
    // 基础上再下移一个 --space-2（Logo 合计 translateY(calc(var(--space-2) * 2))），
    // 主导航区用 padding-block-start 同步下移；不动折叠按钮与红绿灯避让。
    expect(
      declarationsFor(".sh-is-macos .sh-sidebar__brand .sh-brand-logo")["transform"],
    ).toBe("translateY(calc(var(--space-2) * 2))");
    expect(
      declarationsFor(".sh-is-macos .sh-sidebar:not(.is-collapsed) .sh-sidebar__scroll")[
        "padding-block-start"
      ],
    ).toBe("var(--space-2)");
  });

  it("keeps the Windows rhythm and the collapsed sidebar free of the macOS shift", () => {
    // Windows（无 .sh-is-macos 作用域）保持既有声明；导航区位移只允许出现在
    // 带 .sh-is-macos 且排除收起态（:not(.is-collapsed)）的选择器上。
    expect(declarationsFor(".sh-sidebar__brand .sh-brand-logo")["transform"]).toBe(
      "translateY(var(--space-2))",
    );
    expect(declarationsFor(".sh-sidebar__scroll")["padding-block-start"]).toBeUndefined();
    expect(baseCss).not.toMatch(/\.sh-is-macos \.sh-sidebar__scroll/);
    expect(baseCss).not.toMatch(/\.sh-is-macos \.sh-sidebar \.sh-sidebar__scroll/);
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
