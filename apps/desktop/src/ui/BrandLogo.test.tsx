import { render, screen } from "@testing-library/react";
import { BrandLogo } from "./BrandLogo";

it("exposes the approved SkillHub mark with an accessible product name", () => {
  render(<BrandLogo />);

  expect(screen.getByRole("img", { name: "SkillHub" })).toBeInTheDocument();
});

it("inherits the active theme color instead of fixing one palette", () => {
  render(
    <div style={{ color: "rgb(18, 52, 86)" }}>
      <BrandLogo />
    </div>,
  );

  expect(
    getComputedStyle(screen.getByRole("img", { name: "SkillHub" }))
      .backgroundColor,
  ).toBe("rgb(18, 52, 86)");
});
