import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";
import { PageFrame } from "./PageFrame";
import { PageHeader } from "./PageHeader";

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
