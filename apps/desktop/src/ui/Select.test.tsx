import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Field } from "./Field";
import { Select } from "./Select";

describe("Select", () => {
  it("associates the field label and allows choosing an option", async () => {
    const user = userEvent.setup();
    render(
      <Field label="Deployment mode">
        <Select defaultValue="copy" name="mode">
          <option value="copy">Copy</option>
          <option value="link">Symbolic link</option>
        </Select>
      </Field>,
    );

    const select = screen.getByRole("combobox", { name: "Deployment mode" });
    expect(select).toHaveValue("copy");

    await user.selectOptions(select, "link");
    expect(select).toHaveValue("link");
  });

  it("keeps the select reachable by keyboard and shows the invalid state from the field", () => {
    render(
      <Field error="Choose a deployment mode" label="Deployment mode" required>
        <Select name="mode">
          <option value="">Select a mode</option>
          <option value="copy">Copy</option>
        </Select>
      </Field>,
    );

    const select = screen.getByRole("combobox", { name: "Deployment mode" });
    select.focus();
    expect(select).toHaveFocus();
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAttribute("aria-required", "true");
    expect(select.getAttribute("aria-describedby")?.split(" ")).toContain(
      screen.getByRole("alert").id,
    );
  });

  it("exposes a disabled select as neither focusable nor selectable", () => {
    render(
      <Field help="Managed by the library policy" label="Deployment mode">
        <Select disabled name="mode">
          <option value="copy">Copy</option>
        </Select>
      </Field>,
    );

    const select = screen.getByRole("combobox", { name: "Deployment mode" });
    expect(select).toBeDisabled();
    expect(select.getAttribute("aria-describedby")?.split(" ")).toContain(
      screen.getByText("Managed by the library policy").id,
    );
  });
});
