import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SkillCard } from "./SkillCard";
import type { SkillCardViewModel } from "./SkillCardViewModel";

const fullCard: SkillCardViewModel = {
  id: "skills.sh/anthropics/skills/pdf",
  name: "PDF Reader",
  sourceType: "online",
  sourceLabel: "来源：skills.sh",
  sourceAddress: "https://skills.sh/anthropics/skills/pdf",
  description: "读取和处理 PDF 文件。",
  location: "@main",
  metrics: ["安装次数：42"],
  statuses: [{ label: "同名 Skill 已在库中", tone: "success", testId: "imported-1" }],
};

it("renders the title, source, and optional description with independent semantics", () => {
  render(<SkillCard skill={fullCard} />);

  const title = screen.getByRole("heading", { name: "PDF Reader" });
  expect(title.tagName).toBe("H3");
  expect(screen.getByText("来源：skills.sh")).toBeVisible();
  expect(screen.getByText("读取和处理 PDF 文件。")).toBeVisible();
});

it("renders metrics and location metadata when they are provided", () => {
  render(<SkillCard skill={fullCard} />);

  expect(screen.getByText("安装次数：42")).toBeVisible();
  expect(screen.getByText("@main")).toBeVisible();
});

it("renders the status as text next to a marker, never color alone", () => {
  render(<SkillCard skill={fullCard} />);

  const status = screen.getByTestId("imported-1");
  expect(status).toHaveTextContent("同名 Skill 已在库中");
});

it("renders multiple verifiable statuses side by side", () => {
  render(
    <SkillCard
      skill={{
        ...fullCard,
        statuses: [
          { label: "AI 扩展命中", tone: "info", testId: "assist-1" },
          { label: "同名 Skill 已在库中", tone: "success", testId: "imported-1" },
        ],
      }}
    />,
  );

  expect(screen.getByTestId("assist-1")).toHaveTextContent("AI 扩展命中");
  expect(screen.getByTestId("imported-1")).toHaveTextContent("同名 Skill 已在库中");
});

it("honestly omits every optional region that the data does not provide", () => {
  const minimal: SkillCardViewModel = {
    id: "lock/anthropics/skills/pdf",
    name: "PDF",
    sourceType: "lock",
    sourceLabel: "anthropics/skills@v2",
  };
  const { container } = render(<SkillCard skill={minimal} />);

  expect(screen.getByRole("heading", { name: "PDF" })).toBeVisible();
  expect(screen.getByText("anthropics/skills@v2")).toBeVisible();
  expect(screen.queryByText(/PDF 文件/)).not.toBeInTheDocument();
  expect(container.querySelector("ul")).not.toBeInTheDocument();
  // T2 冻结契约回归：未提供副名时不渲染副名区域。
  expect(container.querySelector(".sh-skill-card__subtitle")).not.toBeInTheDocument();
});

// P1-10：集中库卡片需同时展示别名（标题）与原名（小一号副名）。
it("renders an optional subtitle under the title for dual-name display", () => {
  render(<SkillCard skill={{ ...fullCard, subtitle: "pdf-reader" }} />);

  const subtitle = screen.getByText("pdf-reader");
  expect(subtitle).toHaveClass("sh-skill-card__subtitle");
  expect(
    screen.getByRole("heading", { name: "PDF Reader" }).compareDocumentPosition(subtitle) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("keeps the title, the link, and the actions as independent semantics", () => {
  const onInstall = vi.fn();
  render(
    <SkillCard
      skill={fullCard}
      primaryAction={
        <button onClick={onInstall} type="button">
          安装导入
        </button>
      }
      secondaryAction={<a href="https://skills.sh/anthropics/skills/pdf">查看</a>}
    />,
  );

  // 整卡不是按钮：标题保持 heading 语义，动作是独立的按钮/链接。
  expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
  expect(screen.getByRole("link", { name: "查看" })).toHaveAttribute(
    "href",
    "https://skills.sh/anthropics/skills/pdf",
  );
  fireEvent.click(screen.getByRole("button", { name: "安装导入" }));
  expect(onInstall).toHaveBeenCalledTimes(1);
});

it("keeps the action area in the DOM even when only one slot is filled", () => {
  render(
    <SkillCard
      skill={fullCard}
      primaryAction={<button type="button">下载并导入</button>}
    />,
  );

  expect(screen.getByRole("button", { name: "下载并导入" })).toBeVisible();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("renders a decorative source icon that carries no unlabelled meaning", () => {
  const { container } = render(<SkillCard skill={fullCard} />);

  const icon = container.querySelector("svg");
  expect(icon).not.toBeNull();
  expect(icon).toHaveAttribute("aria-hidden", "true");
});

// P1-11 向后兼容扩展：缺省（无 onCardActivate）时渲染与 T2 冻结契约一致。
it("stays inert by default: no tab stop and no activation", () => {
  const onActivate = vi.fn();
  const { container } = render(<SkillCard skill={fullCard} />);

  const article = container.querySelector("article");
  if (!(article instanceof HTMLElement)) throw new Error("Expected the card article");
  expect(article).not.toHaveAttribute("tabindex");
  fireEvent.click(article);
  fireEvent.keyDown(article, { key: "Enter" });
  expect(onActivate).not.toHaveBeenCalled();
});

it("activates from card-body clicks and Enter/Space when onCardActivate is provided", () => {
  const onActivate = vi.fn();
  const { container } = render(
    <SkillCard skill={fullCard} onCardActivate={onActivate} />,
  );

  const article = container.querySelector("article");
  if (!(article instanceof HTMLElement)) throw new Error("Expected the card article");
  expect(article).toHaveAttribute("tabindex", "0");
  fireEvent.click(article);
  fireEvent.keyDown(article, { key: "Enter" });
  fireEvent.keyDown(article, { key: " " });
  expect(onActivate).toHaveBeenCalledTimes(3);
});

it("never activates from clicks inside the action area", () => {
  const onActivate = vi.fn();
  render(
    <SkillCard
      onCardActivate={onActivate}
      primaryAction={<button type="button">安装导入</button>}
      skill={fullCard}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "安装导入" }));
  expect(onActivate).not.toHaveBeenCalled();
});

describe("heading level", () => {
  it("lets consumers raise the card heading to h2", () => {
    render(<SkillCard headingLevel="h2" skill={fullCard} />);

    expect(screen.getByRole("heading", { name: "PDF Reader" }).tagName).toBe("H2");
  });
});
