import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CheckboxField } from "./CheckboxField";
import { Switch } from "./Switch";

function ToggledSwitch() {
  const [enabled, setEnabled] = useState(false);
  return (
    <Switch
      checked={enabled}
      label="Semantic duplicate analysis"
      onChange={(event) => setEnabled(event.currentTarget.checked)}
    />
  );
}

describe("CheckboxField", () => {
  it("toggles from the whole label area, not only the box", async () => {
    const user = userEvent.setup();
    render(
      <CheckboxField
        defaultChecked={false}
        label="Enable online search assist"
      />,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "Enable online search assist",
    });
    expect(checkbox).not.toBeChecked();

    await user.click(screen.getByText("Enable online search assist"));
    expect(checkbox).toBeChecked();

    await user.click(screen.getByText("Enable online search assist"));
    expect(checkbox).not.toBeChecked();
  });

  it("keeps a disabled checkbox announced but inert", async () => {
    const user = userEvent.setup();
    render(
      <CheckboxField
        defaultChecked
        description="Requires an online source"
        disabled
        label="Auto check updates"
      />,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "Auto check updates",
    });
    expect(checkbox).toBeDisabled();
    expect(checkbox).toBeChecked();

    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });
});

describe("Switch", () => {
  it("toggles an immediately effective setting with pointer and keyboard", async () => {
    const user = userEvent.setup();
    render(<ToggledSwitch />);

    const switchControl = screen.getByRole("switch", {
      name: "Semantic duplicate analysis",
    });
    expect(switchControl).not.toBeChecked();

    await user.click(switchControl);
    expect(switchControl).toBeChecked();

    await user.tab(); // move focus away
    switchControl.focus();
    await user.keyboard(" ");
    expect(switchControl).not.toBeChecked();
    await user.keyboard(" ");
    expect(switchControl).toBeChecked();
  });

  it("keeps a disabled switch announced but inert", async () => {
    const user = userEvent.setup();
    render(<Switch defaultChecked disabled label="Description translation" />);

    const switchControl = screen.getByRole("switch", {
      name: "Description translation",
    });
    expect(switchControl).toBeDisabled();
    expect(switchControl).toBeChecked();

    await user.click(switchControl);
    expect(switchControl).toBeChecked();
  });
});
