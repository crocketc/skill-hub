import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { BatchRemovalImpactDialog } from "./BatchRemovalImpactDialog";

it("requires impact choices and a second forced-delete confirmation", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  const onConfirm = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <BatchRemovalImpactDialog
        impacts={[
          {
            deployments: [{ id: "codex", label: "Codex", path: "C:/Codex", physicalId: "codex" }],
            dependentProjects: [],
            operationId: "delete-pdf",
            skillId: "pdf",
            skillName: "PDF Reader",
          },
          {
            deployments: [],
            dependentProjects: [],
            operationId: "delete-docx",
            skillId: "docx",
            skillName: "DOCX Reader",
          },
        ]}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText(/2 Skills are selected for deletion\./)).toBeVisible();
  expect(screen.getByRole("button", { name: "Continue to force deletion" })).toBeDisabled();

  fireEvent.change(screen.getByRole("combobox", { name: "Deployment handling: Codex" }), {
    target: { value: "remove_deployment" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue to force deletion" }));

  expect(screen.getByRole("alertdialog", { name: "Force deletion?" })).toBeVisible();
  fireEvent.change(screen.getByLabelText('Type "FORCE DELETE" to continue'), {
    target: { value: "FORCE DELETE" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Force delete 2 Skills" }));

  expect(onConfirm).toHaveBeenCalledWith({
    "delete-pdf": { codex: "remove_deployment" },
    "delete-docx": {},
  });
});
