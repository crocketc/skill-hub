import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./Field";
import { Input } from "./Input";

describe("Field", () => {
  it("associates the label, help, and error with the input", () => {
    render(
      <Field error="Enter a valid library path" help="Absolute path to the library" label="Library path" required>
        <Input name="library-path" type="text" />
      </Field>,
    );

    const input = screen.getByRole("textbox", { name: "Library path" });
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).toHaveAttribute("aria-invalid", "true");

    const help = screen.getByText("Absolute path to the library");
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("Enter a valid library path");

    const describedBy = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(describedBy).toContain(help.id);
    expect(describedBy).toContain(error.id);
  });

  it("marks the input valid when no error is shown and keeps help described", () => {
    render(
      <Field help="Uses the local credential store" label="API key">
        <Input name="api-key" type="password" />
      </Field>,
    );

    const input = screen.getByLabelText("API key");
    expect(input).not.toHaveAttribute("aria-invalid");

    const help = screen.getByText("Uses the local credential store");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toEqual([help.id]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hides the required marker from the accessible name", () => {
    render(
      <Field label="Endpoint" required>
        <Input name="endpoint" type="url" />
      </Field>,
    );

    expect(screen.getByRole("textbox", { name: "Endpoint" })).toHaveAccessibleName(
      "Endpoint",
    );
  });

  it("wires an explicit field id through the label and passes input attributes through", () => {
    render(
      <Field id="custom-display-name" label="Display name">
        <Input autoComplete="off" name="displayName" placeholder="My skill" />
      </Field>,
    );

    const input = screen.getByPlaceholderText("My skill");
    expect(input).toHaveAttribute("id", "custom-display-name");
    expect(input).toHaveAttribute("name", "displayName");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(screen.getByLabelText("Display name")).toBe(input);
  });

  it("keeps an explicit aria-describedby alongside the field help", () => {
    render(
      <Field help="Built-in help" label="Topic">
        <Input aria-describedby="external-hint" name="topic" />
      </Field>,
    );

    const input = screen.getByRole("textbox");
    const describedBy = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(describedBy).toContain("external-hint");
    expect(describedBy).toContain(screen.getByText("Built-in help").id);
  });
});
