import { fireEvent, render, screen } from "@testing-library/react";
import { WelcomeHero } from "./WelcomeHero";

it("presents the product story and advances to the setup preview", () => {
  const onStart = vi.fn();
  render(<WelcomeHero onStart={onStart} />);

  expect(
    screen.getByRole("heading", {
      name: /把分散的技能，\s*整理成清晰可管理的技能库/,
    }),
  ).toBeVisible();
  expect(screen.getByText(/AI 辅助可选/)).toBeVisible();
  expect(screen.getByRole("img", { name: "SkillHub 管理流程动态演示" })).toBeVisible();
  expect(screen.getByRole("button", { name: "暂停动画" })).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(screen.getByRole("button", { name: "开始设置" }));
  expect(onStart).toHaveBeenCalledOnce();
});

it("lets the user pause and resume the default animation", () => {
  render(<WelcomeHero onStart={() => undefined} />);

  fireEvent.click(screen.getByRole("button", { name: "暂停动画" }));
  expect(screen.getByRole("button", { name: "播放动画" })).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(screen.getByRole("button", { name: "播放动画" }));
  expect(screen.getByRole("button", { name: "暂停动画" })).toHaveAttribute("aria-pressed", "true");
});

it("starts still when the system requests reduced motion", () => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as typeof window.matchMedia;

  try {
    render(<WelcomeHero onStart={() => undefined} />);
    expect(screen.getByRole("button", { name: "播放动画" })).toHaveAttribute("aria-pressed", "false");
  } finally {
    window.matchMedia = originalMatchMedia;
  }
});

it("provides an understandable description of the animated story", () => {
  render(<WelcomeHero onStart={() => undefined} />);

  expect(
    screen.getByText("技能从多处汇入技能库，关系逐渐清晰，冲突由你确认，AI 只提供可选建议。"),
  ).toBeInTheDocument();
});
