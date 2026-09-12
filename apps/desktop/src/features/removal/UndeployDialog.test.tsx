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

  expect(screen.getByText(/This target is shared by several deployment relations/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Confirm undeploy" })).toBeDisabled();
  await user.selectOptions(screen.getByRole("combobox", { name: "Undeploy handling" }), "keep_shared_deployment");
  await user.click(screen.getByRole("button", { name: "Confirm undeploy" }));

  expect(onConfirm).toHaveBeenCalledWith("keep_shared_deployment");
});

it("names the object as undeploying and states retention and recovery in Chinese", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onConfirm = vi.fn();

  render(
    <I18nextProvider i18n={i18n}>
      <UndeployDialog
        impact={{
          deploymentId: "deployment-1",
          label: "Codex CLI",
          operationId: "op-2",
          sharedTarget: false,
        }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    </I18nextProvider>,
  );

  // 对象 2 唯一名称“取消部署”：标题、决策名不复用“移除托管部署”。
  expect(screen.getByRole("heading", { name: "要从 Codex CLI 取消部署吗？" })).toBeVisible();
  const options = [...screen.getAllByRole("option")].map((option) => option.textContent);
  expect(options).toContain("删除目标目录中的部署副本");
  expect(options).toContain("转为独立副本（保留目标文件，移除部署关系）");
  expect(options).not.toContain("移除托管部署");

  // 固定两行：保留什么 + 恢复方式。
  expect(screen.getByText(/保留：库中的 Skill、版本历史与其他部署关系不受影响/)).toBeVisible();
  expect(screen.getByText(/恢复：重新部署同一 Skill/)).toBeVisible();

  await user.selectOptions(screen.getByRole("combobox", { name: "取消部署处理方式" }), "remove_owned_target");
  await user.click(screen.getByRole("button", { name: "确认取消部署" }));
  expect(onConfirm).toHaveBeenCalledWith("remove_owned_target");
});

it("announces the submitting state through the persistent status region", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);

  render(
    <I18nextProvider i18n={i18n}>
      <UndeployDialog
        impact={{
          deploymentId: "deployment-1",
          label: "Codex CLI",
          operationId: "op-2",
          sharedTarget: false,
        }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        submitting
      />
    </I18nextProvider>,
  );

  expect(screen.getByRole("status")).toHaveTextContent("Undeploying…");
  expect(screen.getByRole("button", { name: "Undeploying…" })).toBeDisabled();
});
