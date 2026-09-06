import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { BrandTag } from "./BrandTag";

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
