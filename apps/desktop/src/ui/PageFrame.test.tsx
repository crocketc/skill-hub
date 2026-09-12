import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../styles/base.css";
import { Button } from "./Button";
import { PageFrame } from "./PageFrame";
import { PageHeader } from "./PageHeader";

/** 从注入的样式表中取回指定选择器的规则（精确匹配逗号分隔的任一段）。 */
function ruleFor(selector: string): CSSStyleRule | undefined {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (
        rule instanceof CSSStyleRule &&
        rule.selectorText
          ?.split(",")
          .map((part) => part.trim())
          .includes(selector)
      ) {
        return rule;
      }
    }
  }
  return undefined;
}

describe("PageHeader", () => {
  it("renders the title at heading level 2 by default with its description", () => {
    render(
      <PageHeader
        description="按来源浏览可安装的技能。"
        title="发现技能"
      />,
    );

    const heading = screen.getByRole("heading", { name: "发现技能", level: 2 });
    expect(heading).toBeVisible();
    expect(screen.getByText("按来源浏览可安装的技能。")).toBeVisible();
  });

  it("can claim the h1 for standalone pages without a top bar", () => {
    render(<PageHeader headingLevel="h1" title="技能详情" />);

    expect(
      screen.getByRole("heading", { name: "技能详情", level: 1 }),
    ).toBeVisible();
  });

  it("keeps trailing actions beside the title", () => {
    render(
      <PageHeader
        actions={<Button variant="secondary">普通导入</Button>}
        title="发现技能"
      />,
    );

    expect(screen.getByRole("button", { name: "普通导入" })).toBeVisible();
  });
});

describe("PageFrame", () => {
  it("renders page content inside the frame without owning a heading", () => {
    render(
      <PageFrame width="wide">
        <h2>技能库</h2>
        <p>80 项技能。</p>
      </PageFrame>,
    );

    expect(screen.getByRole("heading", { name: "技能库" })).toBeVisible();
    expect(screen.getByText("80 项技能。")).toBeVisible();
  });
});

describe("page top alignment (M-10)", () => {
  // M-10：满屏高度下页头与正文之间出现整段空白——根因是共享栅格容器
  // （content 区、PageFrame、发现页容器）在 align-content:normal 下把
  // 剩余高度摊进行高。契约：行必须钉在容器顶部，剩余空间留在底部。
  it("pins shared page grids to the top instead of stretching rows", () => {
    for (const selector of [
      ".sh-app-shell__content",
      ".sh-page-frame",
      ".sh-discovery-page",
    ]) {
      const rule = ruleFor(selector);
      expect(rule, `${selector} is defined in the shared stylesheet`).toBeDefined();
      expect(
        rule!.style.getPropertyValue("align-content"),
        `${selector} rows must not stretch on tall viewports`,
      ).toBe("start");
    }
  });

  it("keeps PageFrame markup header-first so top alignment is observable", () => {
    render(
      <PageFrame width="wide">
        <PageHeader title="待办" />
        <section>正文</section>
      </PageFrame>,
    );

    const frame = screen.getByText("正文").parentElement!;
    expect(frame).toHaveClass("sh-page-frame");
    expect(frame.firstElementChild).toHaveClass("sh-page-header");
  });
});
