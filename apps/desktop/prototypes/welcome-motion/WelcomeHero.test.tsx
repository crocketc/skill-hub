import { fireEvent, render, screen } from "@testing-library/react";
import { WelcomeHero } from "./WelcomeHero";

it("presents the product story and advances to the setup preview", () => {
  const onStart = vi.fn();
  render(<WelcomeHero onStart={onStart} />);

  expect(
    screen.getByRole("heading", {
      name: /让每一项技能，\s*都有清晰的来路与去向/,
    }),
  ).toBeVisible();
  expect(screen.getByText(/AI 辅助可选/)).toBeVisible();
  expect(screen.getByText(/一项 Skill 的完整旅程/)).toBeVisible();
  expect(screen.getByRole("button", { name: "暂停动画" })).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(screen.getByRole("button", { name: "开始设置" }));
  expect(onStart).toHaveBeenCalledOnce();
});

it("lets the user pause and resume the default animation", () => {
  render(<WelcomeHero onStart={() => undefined} />);

  fireEvent.click(screen.getByRole("button", { name: "暂停动画" }));
  expect(screen.getByRole("button", { name: "播放动画" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("main")).toHaveAttribute("data-playback", "paused");

  fireEvent.click(screen.getByRole("button", { name: "播放动画" }));
  expect(screen.getByRole("button", { name: "暂停动画" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("main")).toHaveAttribute("data-playback", "playing");
});

it("autoplays when the system requests reduced motion", () => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as typeof window.matchMedia;

  try {
    render(<WelcomeHero onStart={() => undefined} />);
    expect(screen.getByRole("button", { name: "暂停动画" })).toHaveAttribute("aria-pressed", "true");
  } finally {
    window.matchMedia = originalMatchMedia;
  }
});

it("provides an understandable description of the animated story", () => {
  render(<WelcomeHero onStart={() => undefined} />);

  expect(screen.getByText(/导入后发现同名冲突/)).toBeInTheDocument();
});

it("shows the full Skill lifecycle in one connected composition", () => {
  render(<WelcomeHero onStart={() => undefined} />);

  for (const title of ["导入技能", "处理冲突", "技能图谱", "配置到 Agent", "配置到项目", "关系治理", "标签配置与收回", "AI 辅助管理"]) {
    expect(screen.getByRole("heading", { name: title })).toBeVisible();
  }
  expect(screen.getAllByRole("listitem")).toHaveLength(8);
  expect(screen.getByRole("button", { name: "暂停动画" })).toHaveAttribute("aria-pressed", "true");
});
