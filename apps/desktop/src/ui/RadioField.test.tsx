import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import baseCss from "../styles/base.css?raw";
import { RadioField } from "./RadioField";

function DensityHarness() {
  const [density, setDensity] = useState("standard");
  return (
    <div role="radiogroup" aria-label="Density">
      <RadioField
        checked={density === "compact"}
        label="Compact"
        name="density"
        onChange={() => setDensity("compact")}
      />
      <RadioField
        checked={density === "standard"}
        label="Standard"
        name="density"
        onChange={() => setDensity("standard")}
      />
      <output>{density}</output>
    </div>
  );
}

describe("RadioField", () => {
  it("selects from the whole label area and keeps one radio per group checked", async () => {
    const user = userEvent.setup();
    render(<DensityHarness />);

    const compact = screen.getByRole("radio", { name: "Compact" });
    const standard = screen.getByRole("radio", { name: "Standard" });
    expect(compact).not.toBeChecked();
    expect(standard).toBeChecked();

    await user.click(screen.getByText("Compact"));
    expect(compact).toBeChecked();
    expect(standard).not.toBeChecked();
    expect(screen.getByRole("status").textContent).toBe("compact");
  });

  it("moves the selection with the keyboard arrow keys", async () => {
    const user = userEvent.setup();
    render(<DensityHarness />);

    const standard = screen.getByRole("radio", { name: "Standard" });
    standard.focus();
    await user.keyboard("{ArrowUp}");

    expect(screen.getByRole("radio", { name: "Compact" })).toBeChecked();
    expect(screen.getByRole("status").textContent).toBe("compact");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Compact" }));
  });

  it("keeps a disabled radio announced but inert", async () => {
    const user = userEvent.setup();
    render(
      <RadioField
        defaultChecked
        description="Managed by workspace policy"
        disabled
        label="Follow system setting"
      />,
    );

    const radio = screen.getByRole("radio", { name: "Follow system setting" });
    expect(radio).toBeDisabled();
    expect(radio).toBeChecked();
    expect(radio).toHaveAccessibleDescription("Managed by workspace policy");

    await user.click(radio);
    expect(radio).toBeChecked();
  });

  it("renders the shared control-field contract classes and token sizing", () => {
    render(<RadioField defaultChecked={false} label="Compact" name="density" />);

    expect(screen.getByText("Compact").closest("label")).toHaveClass("sh-radio-field");
    expect(screen.getByRole("radio", { name: "Compact" })).toHaveClass("sh-radio-field__input");

    // 与 .sh-checkbox-field__input 同尺寸：1.125rem 见方，仅依赖既有语义 token。
    expect(baseCss).toMatch(
      /\.sh-radio-field__input\s*\{[^}]*width:\s*1\.125rem[^}]*accent-color:\s*var\(--ui-accent\)/,
    );
  });
});
