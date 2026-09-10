import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Field } from "./Field";
import { Input } from "./Input";
import { focusFirstInvalidField } from "./focusFirstInvalidField";

it("focuses the first field marked invalid in DOM order", () => {
  render(
    <form aria-label="Add provider">
      <Field label="Label">
        <Input name="label" />
      </Field>
      <Field error="Enter the endpoint" label="Endpoint" required>
        <Input name="endpoint" />
      </Field>
      <Field error="Choose the protocol" label="Protocol" required>
        <Input name="protocol" />
      </Field>
    </form>,
  );

  const form = screen.getByRole("form", { name: "Add provider" });
  expect(focusFirstInvalidField(form)).toBe(true);
  expect(screen.getByRole("textbox", { name: "Endpoint" })).toHaveFocus();
  expect(screen.getByRole("textbox", { name: "Label" })).not.toHaveFocus();
});

it("reports false and leaves focus untouched when nothing is invalid", () => {
  render(
    <form aria-label="Clean form">
      <Field label="Label">
        <Input name="label" />
      </Field>
    </form>,
  );

  const form = screen.getByRole("form", { name: "Clean form" });
  expect(focusFirstInvalidField(form)).toBe(false);
  expect(document.activeElement).toBe(document.body);
});
