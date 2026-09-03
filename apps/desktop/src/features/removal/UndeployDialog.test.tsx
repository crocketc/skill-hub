import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { UndeployDialog } from "./UndeployDialog";

it("keeps shared files and commits only after an explicit undeploy choice", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["en-US"]);
  const onConfirm = vi.fn();

  render(
    <I18nextProvider i18n={i18n}>
      <UndeployDialog
        impact={{
          deploymentId: "deployment-1",
          label: "Codex CLI",
          operationId: "op-2",
          sharedTarget: true,
        }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText("This target is shared. Its files will remain available to other relations.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Confirm undeploy" })).toBeDisabled();
  await user.selectOptions(screen.getByRole("combobox", { name: "Undeploy handling" }), "keep_shared_deployment");
  await user.click(screen.getByRole("button", { name: "Confirm undeploy" }));

  expect(onConfirm).toHaveBeenCalledWith("keep_shared_deployment");
});
