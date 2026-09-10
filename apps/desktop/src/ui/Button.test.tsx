import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("keeps the original action label, aria-busy, and disabled state while loading", () => {
    render(<Button loading>保存更改</Button>);

    const button = screen.getByRole("button", { name: "保存更改" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("保存更改");
  });

  it("shows a loading indicator that assistive tech does not re-announce", () => {
    render(<Button loading>保存更改</Button>);

    const button = screen.getByRole("button", { name: "保存更改" });
    const indicator = button.querySelector("[data-loading-indicator]");
    expect(indicator).not.toBeNull();
    expect(indicator).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a plain enabled button without a loading marker otherwise", () => {
    render(<Button>保存更改</Button>);

    const button = screen.getByRole("button", { name: "保存更改" });
    expect(button.querySelector("[data-loading-indicator]")).toBeNull();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button).toBeEnabled();
  });
});
