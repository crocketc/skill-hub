import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

describe("Icon", () => {
  it("renders a registry icon as decorative and hidden from assistive tech", () => {
    const { container } = render(<Icon name="search" />);

    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg?.querySelector("path")).not.toBeNull();
  });

  it("scales the icon through the shared size steps", () => {
    const { container } = render(<Icon name="deploy" size={20} />);

    expect(container.querySelector("svg")).toHaveAttribute("width", "20");
    expect(container.querySelector("svg")).toHaveAttribute("height", "20");
  });
});

describe("IconButton", () => {
  it("carries an explicit accessible name from its label, not the icon", () => {
    render(<IconButton icon="delete" label="Delete skill" />);

    const button = screen.getByRole("button", { name: "Delete skill" });
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps its type as button unless a caller overrides it", () => {
    render(<IconButton icon="open-external" label="Open in explorer" />);

    expect(screen.getByRole("button", { name: "Open in explorer" })).toHaveAttribute(
      "type",
      "button",
    );
  });
});
