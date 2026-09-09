import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { brandIconSrc, BRAND_ICON_FILES, BrandTag } from "./BrandTag";

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
  expect(shipped).toHaveLength(17);

  const mapped = [...new Set(Object.values(BRAND_ICON_FILES))].sort();
  expect(mapped).toEqual(shipped);
  for (const file of mapped) {
    expect(existsSync(path.join(assetDir, file))).toBe(true);
  }
});
