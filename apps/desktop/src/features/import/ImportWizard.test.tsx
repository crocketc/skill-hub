import { screen, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { createMockImportFacade } from "./api";
import { ImportWizard } from "./ImportWizard";

async function renderWizard(facade = createMockImportFacade({ scenario: "safe-local" })) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportWizard facade={facade} />
    </I18nextProvider>,
  );
  return facade;
}

async function renderGuidedWizard(facade = createMockImportFacade({ scenario: "safe-local" })) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportWizard
        facade={facade}
        initialSources={["C:/codex/skills", "C:/claude/skills"]}
        initialSourceText="C:/codex/skills"
      />
    </I18nextProvider>,
  );
  return facade;
}

it("parses npx text without executing it and reaches candidate selection", async () => {
  const user = userEvent.setup();
  const facade = await renderWizard();
  await user.type(screen.getByLabelText("来源"), "npx skills add github:owner/repo");
  await user.click(screen.getByRole("button", { name: "解析来源" }));

  expect(await screen.findByText("仅解析来源，不会执行 npx 命令")).toBeVisible();
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeVisible();
  expect(facade.calls.executedCommands).toEqual([]);
});

it("suggests takeover for Agent-owned candidates and requires explicit selection", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "agent-owned-partial" });
  await renderWizard(facade);
  await user.type(screen.getByLabelText("来源"), "C:\\Agents\\codex\\skills");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));

  expect(await screen.findByRole("radio", { name: "保留当前位置并纳入管理" })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "提交导入" })).toBeDisabled();
});

it("preserves source text after cancellation", async () => {
  const user = userEvent.setup();
  await renderWizard(createMockImportFacade({ scenario: "cancelled" }));
  await user.type(screen.getByLabelText("来源"), "C:\\Skills\\pdf");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "取消获取" }));

  expect(screen.getByLabelText("来源")).toHaveValue("C:\\Skills\\pdf");
});

it("acquires candidates from every selected scanned source", async () => {
  const user = userEvent.setup();
  const facade = await renderGuidedWizard();

  await user.click(screen.getByRole("button", { name: "解析来源" }));

  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeVisible();
  expect(facade.calls.acquiredSources).toEqual(["C:/codex/skills", "C:/claude/skills"]);
  expect(screen.getByText("找到 4 个候选项，请先审阅列表。")).toBeVisible();
});

it("fills the source from the native directory picker", async () => {
  const user = userEvent.setup();
  const picker = { pickDirectory: vi.fn(async () => "C:/picked/skills") };
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportWizard directoryPicker={picker} />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("button", { name: "选择本地目录" }));

  expect(await screen.findByDisplayValue("C:/picked/skills")).toBeVisible();
  expect(picker.pickDirectory).toHaveBeenCalledOnce();
});
