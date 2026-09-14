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
    expect(declarationsFor(".sh-is-macos .sh-sidebar__header")["padding-left"]).toBe(
      "5rem",
    );
    expect(
      declarationsFor(".sh-is-macos .sh-sidebar__toggle")["top"],
    ).toBe("calc(50% - var(--space-4) + var(--space-6))");
    expect(
      declarationsFor(".sh-is-macos .sh-app-shell.is-sidebar-collapsed .sh-app-shell__topbar-start")[
        "padding-inline-start"
      ],
    ).toBe("5rem");
  });

  it("drops the retired sidebar-resident toggle and query-tools layout rules", () => {
    // 遗留风险清理（2026-09-14）：query-tools 仅存的元素级残留选择器
    // （input/select/button 与活类并组）也拆分删除，base.css 不再有痕迹。
    expect(baseCss).not.toContain("query-tools");
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
