import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { RecoveryPage } from "./RecoveryPage";
import type { OperationFacade, OperationState } from "../operations/api";

it("opens the requested recovery directly and refreshes the startup state after resolution", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onResolved = vi.fn(async () => undefined);
  const resolveRecovery = vi.fn(async () => undefined);
  const facade = createFacade({
    listRecoveryCandidates: async () => [
      { operationId: "op-first", actions: ["rollback_operation"], kind: "deploy_skill", objectName: null, createdAt: "1789890340" },
      { operationId: "op-requested", actions: ["rollback_operation"], kind: "delete_skill", objectName: "Notes", createdAt: "1789890341" },
    ],
    resolveRecovery,
  });
  render(<MemoryRouter><I18nextProvider i18n={i18n}><RecoveryPage facade={facade} initialOperationId="op-requested" onResolved={onResolved} /></I18nextProvider></MemoryRouter>);
  // DEV-98：候选与摘要用「本地化操作名：对象名」呈现，技术 id 和原始 kind
  // 不再出现在界面（operation id 只作为内部 value）。
  expect(await screen.findByRole("radio", { name: "删除技能：Notes" })).toBeChecked();
  expect(await screen.findByText("删除技能：Notes")).toBeVisible();
  expect(screen.queryByText(/op-requested/)).toBeNull();
  expect(screen.queryByText("delete_skill")).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "撤销未完成改动" }));
  expect(resolveRecovery).toHaveBeenCalledWith("op-requested", "rollback_operation");
  expect(onResolved).toHaveBeenCalledOnce();
});

const operation: OperationState = {
  operationId: "op-recover",
  phase: "needs_recovery",
  completed: 0,
  total: 1,
  message: "deployment.target_conflict",
};

function createFacade(overrides: Partial<OperationFacade> = {}): OperationFacade {
  return {
    async get(operationId) {
      return { ...operation, operationId };
    },
    async listRecoveryCandidates() {
      return [{ operationId: "op-recover", actions: ["complete_operation", "rollback_operation"] }];
    },
    async resolveRecovery() {
      return;
    },
    async listDeploymentConflictBackups() {
      return [];
    },
    async restoreDeploymentConflictBackup() {
      return;
    },
    ...overrides,
  };
}

async function renderPage(facade: OperationFacade = createFacade()) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  // 页面挂载后会立刻去读候选与选中项，用 act 包住渲染才不会留下更新警告。
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <RecoveryPage facade={facade} />
        </MemoryRouter>
      </I18nextProvider>,
    );
  });
  return result as ReturnType<typeof render>;
}

it("defaults to the operation records tab", async () => {
  await renderPage();

  expect(await screen.findByRole("tab", { selected: true })).toHaveTextContent("操作记录");
  expect(screen.getByRole("tabpanel")).toBeVisible();
});

it("restores a replaced item only after confirmation and refreshes the list", async () => {
  const user = userEvent.setup();
  const restoreDeploymentConflictBackup = vi.fn(async () => undefined);
  const listDeploymentConflictBackups = vi.fn()
    .mockResolvedValueOnce([{
      backup_id: "opaque-backup-id",
      target_label: "Claude 全局技能",
      entry_name: "my-skill",
      entry_kind: "directory",
    }])
    .mockResolvedValueOnce([]);
  await renderPage(createFacade({ listDeploymentConflictBackups, restoreDeploymentConflictBackup }));

  await user.click(screen.getByRole("tab", { name: "已替换内容" }));
  expect(await screen.findByText("my-skill")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "恢复这份内容" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("当前内容会另存为一条可恢复记录");
  await user.click(screen.getByRole("button", { name: "确认恢复" }));

  expect(restoreDeploymentConflictBackup).toHaveBeenCalledWith("opaque-backup-id");
  expect(await screen.findByText("暂无可恢复的替换内容。")).toBeVisible();
  expect(listDeploymentConflictBackups).toHaveBeenCalledTimes(2);
});

it("switches to the unfinished operations tab and shows the supported recovery actions", async () => {
  const user = userEvent.setup();
  await renderPage();

  await user.click(screen.getByRole("tab", { name: "未完成操作" }));
  expect(screen.getByRole("tabpanel")).toHaveTextContent("deployment.target_conflict");
  expect(screen.getByRole("button", { name: "继续完成操作" })).toBeVisible();
  expect(screen.getByRole("button", { name: "撤销未完成改动" })).toBeVisible();
});

/**
 * 恢复闸门列出**全部**候选：只认「最新一条」会让 UI 在候选不是最新那条时
 * 无路可走，应用就永久卡在恢复页。
 */
it("lists every recovery candidate so the gate always has an exit", async () => {
  const user = userEvent.setup();
  await renderPage(createFacade({
    async listRecoveryCandidates() {
      return [
        { operationId: "op-first", actions: ["rollback_operation"], kind: "import_skill", objectName: "Writer", createdAt: "1789890340" },
        { operationId: "op-second", actions: ["rollback_operation"] },
      ];
    },
  }));

  await user.click(screen.getByRole("tab", { name: "未完成操作" }));
  // DEV-98：有快照事实的候选显示「操作名：对象名」；缺快照的如实标注未知操作，
  // 两种情况都不暴露技术 id。
  expect(screen.getByLabelText("导入技能：Writer")).toBeVisible();
  expect(screen.getByLabelText("未知操作")).toBeVisible();
  expect(screen.queryByText(/op-first/)).toBeNull();
});

it("recovers the selected candidate through resolve_recovery", async () => {
  const user = userEvent.setup();
  const resolveRecovery = vi.fn(async () => undefined);
  await renderPage(createFacade({ resolveRecovery }));

  await user.click(screen.getByRole("tab", { name: "未完成操作" }));
  await act(async () => {
    await user.click(screen.getByRole("button", { name: "撤销未完成改动" }));
  });

  expect(resolveRecovery).toHaveBeenCalledWith("op-recover", "rollback_operation");
  expect(screen.getByRole("status")).toHaveTextContent("未完成的改动已撤销");
});

it("uses the selected candidate's complete action instead of always rolling back", async () => {
  const user = userEvent.setup();
  const resolveRecovery = vi.fn(async () => undefined);
  await renderPage(createFacade({
    async listRecoveryCandidates() {
      return [{ operationId: "op-recover", actions: ["complete_operation"] }];
    },
    resolveRecovery,
  }));

  await user.click(screen.getByRole("tab", { name: "未完成操作" }));
  await user.click(screen.getByRole("button", { name: "继续完成操作" }));

  expect(resolveRecovery).toHaveBeenCalledWith("op-recover", "complete_operation");
});

it("does not offer a generic recovery action when the backend provides none", async () => {
  const user = userEvent.setup();
  const resolveRecovery = vi.fn(async () => undefined);
  await renderPage(createFacade({
    async listRecoveryCandidates() {
      return [{ operationId: "op-recover", actions: [] }];
    },
    resolveRecovery,
  }));

  await user.click(screen.getByRole("tab", { name: "未完成操作" }));

  expect(await screen.findByText("此操作目前没有可安全执行的自动恢复方式，请联系支持人员。"))
    .toBeVisible();
  expect(screen.queryByRole("button", { name: "继续完成操作" })).toBeNull();
  expect(screen.queryByRole("button", { name: "撤销未完成操作" })).toBeNull();
  expect(resolveRecovery).not.toHaveBeenCalled();
});

it("reports a failed recovery readably instead of rendering [object Object]", async () => {
  const user = userEvent.setup();
  await renderPage(createFacade({
    async resolveRecovery() {
      // Tauri IPC 的 rejection 是结构化对象，不是 Error 实例。
      throw { code: "operation.conflict", severity: "error", params: { field: "recovery_candidate" }, actions: ["retry"] };
    },
  }));

  await user.click(screen.getByRole("tab", { name: "未完成操作" }));
  await act(async () => {
    await user.click(screen.getByRole("button", { name: "撤销未完成改动" }));
  });

  const message = screen.getByRole("status");
  expect(message).toHaveTextContent("恢复失败");
  expect(message).toHaveTextContent("operation.conflict");
  expect(message).not.toHaveTextContent("[object Object]");
});

it("keeps every recovery candidate available and retries only the selected detail after a read failure", async () => {
  const user = userEvent.setup();
  const get = vi.fn()
    .mockRejectedValueOnce(new Error("temporary detail read failure"))
    .mockResolvedValueOnce({
      ...operation,
      kind: "import_skill",
      objectName: "Writer",
    });
  await renderPage(createFacade({
    get,
    async listRecoveryCandidates() {
      return [
        { operationId: "op-recover", actions: ["rollback_operation"], kind: "import_skill", objectName: "Writer" },
        { operationId: "op-other", actions: ["rollback_operation"], kind: "delete_skill", objectName: "Notes" },
      ];
    },
  }));

  await user.click(screen.getByRole("tab", { name: "未完成操作" }));
  expect(screen.getByRole("radio", { name: "导入技能：Writer" })).toBeVisible();
  expect(screen.getByRole("radio", { name: "删除技能：Notes" })).toBeVisible();
  expect(screen.getByText(/temporary detail read failure/)).toBeVisible();
  expect(screen.getByRole("button", { name: "撤销未完成改动" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "重试加载详情" }));

  expect(get).toHaveBeenCalledTimes(2);
  expect(await screen.findByText(/操作未能完成/)).toBeVisible();
  expect(screen.getByRole("button", { name: "撤销未完成改动" })).toBeEnabled();
});

it("does not let a slower previous detail replace the newly selected operation", async () => {
  const user = userEvent.setup();
  let resolveFirst: ((state: OperationState) => void) | undefined;
  const firstDetail = new Promise<OperationState>((resolve) => { resolveFirst = resolve; });
  const get = vi.fn((operationId: string) => operationId === "op-recover"
    ? firstDetail
    : Promise.resolve({ ...operation, operationId, kind: "delete_skill", objectName: "Notes" }));
  await renderPage(createFacade({
    get,
    async listRecoveryCandidates() {
      return [
        { operationId: "op-recover", actions: ["rollback_operation"], kind: "import_skill", objectName: "Writer" },
        { operationId: "op-other", actions: ["rollback_operation"], kind: "delete_skill", objectName: "Notes" },
      ];
    },
  }));

  await user.click(screen.getByRole("tab", { name: "未完成操作" }));
  await user.click(screen.getByRole("radio", { name: "删除技能：Notes" }));
  expect(await screen.findByText("删除技能：Notes", { selector: "strong" })).toBeVisible();

  await act(async () => {
    resolveFirst?.({ ...operation, operationId: "op-recover", kind: "import_skill", objectName: "Writer" });
  });

  expect(screen.getByText("删除技能：Notes", { selector: "strong" })).toBeVisible();
  expect(screen.queryByText("导入技能：Writer", { selector: "strong" })).toBeNull();
});

it("says so plainly when nothing needs recovery", async () => {
  const user = userEvent.setup();
  await renderPage(createFacade({ async listRecoveryCandidates() { return []; } }));

  await user.click(screen.getByRole("tab", { name: "未完成操作" }));
  expect(screen.getByText("当前没有需要恢复的操作。")).toBeVisible();
  expect(screen.queryByRole("button", { name: "撤销未完成改动" })).not.toBeInTheDocument();
});

it("wires each tab to its panel with aria-controls and roving tabindex", async () => {
  await renderPage();

  const records = screen.getByRole("tab", { name: "操作记录" });
  const unfinished = screen.getByRole("tab", { name: "未完成操作" });
  const replaced = screen.getByRole("tab", { name: "已替换内容" });

  expect(records).toHaveAttribute("aria-controls", "recovery-panel-records");
  expect(unfinished).toHaveAttribute("aria-controls", "recovery-panel-unfinished");
  expect(replaced).toHaveAttribute("aria-controls", "recovery-panel-replaced");

  // 选中页签可 Tab 进入，未选中页签由方向键到达（roving tabindex）。
  expect(records).toHaveAttribute("tabindex", "0");
  expect(unfinished).toHaveAttribute("tabindex", "-1");
  expect(replaced).toHaveAttribute("tabindex", "-1");

  await userEvent.setup().click(unfinished);
  expect(unfinished).toHaveAttribute("tabindex", "0");
  expect(records).toHaveAttribute("tabindex", "-1");
  expect(screen.getByRole("tabpanel", { name: "未完成操作" })).toHaveAttribute("id", "recovery-panel-unfinished");
});

it("moves selection and focus with the arrow keys and wraps at the ends", async () => {
  const user = userEvent.setup();
  await renderPage();

  const records = screen.getByRole("tab", { name: "操作记录" });
  const unfinished = screen.getByRole("tab", { name: "未完成操作" });
  const replaced = screen.getByRole("tab", { name: "已替换内容" });

  await user.click(records);
  records.focus();

  await user.keyboard("{ArrowRight}");
  expect(unfinished).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(unfinished);

  await user.keyboard("{ArrowRight}");
  expect(replaced).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(replaced);

  // 从末尾向右循环回第一个页签。
  await user.keyboard("{ArrowRight}");
  expect(records).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(records);

  // 从开头向左循环到最后一个页签。
  await user.keyboard("{ArrowLeft}");
  expect(replaced).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(replaced);

  await user.keyboard("{Home}");
  expect(records).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(records);

  await user.keyboard("{End}");
  expect(replaced).toHaveAttribute("aria-selected", "true");
  expect(document.activeElement).toBe(replaced);
});
