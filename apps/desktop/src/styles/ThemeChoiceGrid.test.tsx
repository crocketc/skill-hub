import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../i18n";
import { ThemeChoiceGrid } from "./ThemeChoiceGrid";

it("shows named palette previews and reports the selected theme", async () => {
  const onChange = vi.fn();
  const i18n = await createSkillHubI18n(["en-US"]);

  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <ThemeChoiceGrid onChange={onChange} value="moss-neutral" />
    </I18nextProvider>,
  );

  expect(screen.getByRole("button", { name: /Sakura/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(container.querySelectorAll(".sh-theme-choice__palette").length).toBeGreaterThan(1);

  fireEvent.click(screen.getByRole("button", { name: /Sakura/ }));

  expect(onChange).toHaveBeenCalledWith("sakura");
});
