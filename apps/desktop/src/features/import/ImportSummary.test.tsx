import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { ImportResult } from "./api";
import { ImportSummary } from "./ImportSummary";

const results: ImportResult[] = [
  { candidateId: "a", action: "copy", status: "succeeded", message: "已导入" },
  { candidateId: "b", action: "skip", status: "skipped", message: "已跳过" },
  { candidateId: "c", action: "independent", status: "failed", message: "写入失败" },
];

it("summarizes all outcomes and expands successful details only on request", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary results={results} />
    </I18nextProvider>,
  );

  expect(screen.getByText("成功 1")).toBeVisible();
  expect(screen.getByText("跳过 1")).toBeVisible();
  expect(screen.getByText("失败 1")).toBeVisible();
  expect(screen.getByText("写入失败")).toBeVisible();
  expect(screen.queryByText("已跳过")).not.toBeInTheDocument();
  expect(screen.getAllByRole("listitem")).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "查看成功和跳过明细" }));
  expect(screen.getAllByText("已导入")[0]).toBeVisible();
  expect(screen.getAllByText("已跳过")[0]).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
});

it("translates the native loop's structured failure codes into readable copy", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary
        results={[
          {
            candidateId: "c",
            action: "copy",
            status: "failed",
            message: "import.import_failed",
          },
        ]}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText("导入未完成：本机服务在处理该候选项时失败。")).toBeVisible();
  expect(screen.queryByText("import.import_failed")).not.toBeInTheDocument();
});

it("keeps the structured reason in data without rendering it as user copy", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary
        results={[{
          candidateId: "c",
          action: "copy",
          status: "failed",
          message: "importWorkflow.errors.unknown",
          reasonCode: "import.same_runtime_name_conflict",
          originalPreserved: true,
          governanceTasks: [],
        }]}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText("导入步骤未能完成。")) .toBeVisible();
  expect(screen.queryByText("import.same_runtime_name_conflict")).not.toBeInTheDocument();
});

it("shows todo outcomes as actionable results instead of hiding them as success", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const todo = {
    candidateId: "c",
    action: "copy",
    status: "todo",
    message: "importWorkflow.commitMessages.imported",
    originalPreserved: true,
    reasonCode: "import.governance_todo_created",
    governanceTasks: [],
  } as unknown as ImportResult;
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary results={[todo]} />
    </I18nextProvider>,
  );

  expect(screen.getByText("待处理 1")).toBeVisible();
  expect(screen.getByText("待处理")).toBeVisible();
  expect(screen.getByRole("listitem")).toBeVisible();
});

it("shows the unavailable boundary without fabricating import results", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary unavailable results={[]} />
    </I18nextProvider>,
  );

  expect(screen.getByRole("status")).toHaveTextContent("导入功能尚未连接到本机服务");
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
});

it("renders the import provenance line only when evidence was recorded", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary
        results={[
          {
            candidateId: "a",
            action: "copy",
            status: "succeeded",
            message: "已导入",
            provenance: {
              agentClientId: "trae.code",
              originalPath: "/agents/trae/skills/demo",
              importedAt: "1700000000",
            },
          },
          {
            candidateId: "b",
            action: "copy",
            status: "succeeded",
            message: "已导入",
            // 来源不明：Agent 归属显式缺省，界面只标注不猜测。
            provenance: {
              agentClientId: null,
              originalPath: "/downloads/demo",
              importedAt: "1700000001",
            },
          },
        ]}
      />
    </I18nextProvider>,
  );

  // 成功明细默认折叠：先展开再核验存证行。
  fireEvent.click(screen.getByRole("button", { name: "查看成功和跳过明细" }));
  expect(screen.getAllByTestId("import-provenance")).toHaveLength(2);
  expect(screen.getAllByTestId("import-provenance")[0]).toHaveTextContent("来源 Agent：");
  expect(screen.getAllByTestId("import-provenance")[0]).toHaveTextContent("路径：");
  expect(screen.queryByText("trae.code")).not.toBeInTheDocument();
  // 普通本地目录用「本地目录」标注，不再猜测或留空归属。
  expect(screen.getAllByTestId("import-provenance")[1]).toHaveTextContent("本地目录");
  expect(screen.getAllByTestId("import-provenance")[1]).toHaveTextContent("路径：");
});

it("keeps the original copy and exposes the relationship-governance todo after a partial import", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary
        results={[
          {
            candidateId: "shared-pdf",
            action: "copy",
            status: "succeeded",
            message: "已导入",
            governanceTasks: [{
              task_id: "import-governance:shared-pdf",
              kind: "confirm_shared_directory_impact",
              subject_id: "shared-pdf",
              detail: "确认共享目录影响",
              resolved: false,
              created_at: "1",
              resolved_at: null,
            }],
            originalPreserved: true,
          },
          {
            candidateId: "readonly-notes",
            action: "copy",
            status: "failed",
            message: "写入失败",
            governanceTasks: [{
              task_id: "import-governance:readonly-notes",
              kind: "unknown_directory_recognition",
              subject_id: "readonly-notes",
              detail: "检查权限后重试",
              resolved: false,
              created_at: "1",
              resolved_at: null,
            }],
            originalPreserved: true,
          },
        ]}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText("原始副本保持不变；如需清理，请在关系治理中单独确认并保留回退路径。")).toBeVisible();
  expect(screen.queryByRole("link", { name: /关系治理待办/ })).not.toBeInTheDocument();
});

it("renders the added import summary copy in the active English locale", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary
        results={[{
          candidateId: "shared-pdf",
          action: "copy",
          status: "succeeded",
          message: "importWorkflow.commitMessages.imported",
          originalPreserved: true,
          governanceTasks: [{
            task_id: "governance-task-1",
            kind: "confirm_shared_directory_impact",
            subject_id: "shared-pdf",
            detail: "Shared directory impact requires review",
            resolved: false,
            created_at: "1",
            resolved_at: null,
          }],
        }]}
        onOpenGovernanceTask={vi.fn()}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText("Original copies remain unchanged; cleanup is a separate confirmed action with a recovery path.")).toBeVisible();
  expect(screen.getByRole("button", { name: "View governance task governance-task-1" })).toBeVisible();
});

it("offers relationship governance only after a successful import", async () => {
  const onOpenGovernance = vi.fn();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary
        manageableSourceCount={1}
        onOpenGovernance={onOpenGovernance}
        results={[{
          candidateId: "shared-pdf",
          action: "copy",
          status: "succeeded",
          message: "importWorkflow.commitMessages.imported",
          originalPreserved: true,
        }]}
      />
    </I18nextProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "整理来源副本" }));
  expect(onOpenGovernance).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "稍后处理" })).toBeVisible();
});
// —— 任务 10：完成页 CTA 只由后端 manageableSourceCount 与失败数决定 ——

const cleanResults: ImportResult[] = [
  { candidateId: "a", action: "copy", status: "succeeded", message: "已导入" },
  { candidateId: "b", action: "copy", status: "succeeded", message: "已导入" },
];

async function renderSummary(
  props: Partial<Omit<Parameters<typeof ImportSummary>[0], "results">> & { results?: ImportResult[] },
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ImportSummary results={[]} {...props} />
    </I18nextProvider>,
  );
}

it("makes retry the primary action with failures and organizes source copies secondary", async () => {
  const onRetryFailed = vi.fn();
  const onOpenGovernance = vi.fn();
  await renderSummary({
    results: [
      ...cleanResults,
      { candidateId: "c", action: "copy", status: "failed", message: "写入失败" },
    ],
    manageableSourceCount: 2,
    onRetryFailed,
    onOpenGovernance,
  });

  // 有失败时主按钮是重试失败项；来源整理退为次按钮，不与恢复操作争夺主次。
  const retry = screen.getByRole("button", { name: "重试失败项" });
  expect(retry).toHaveClass("sh-button--primary");
  const organize = screen.getByRole("button", { name: "整理来源副本" });
  expect(organize).toHaveClass("sh-button--secondary");
  await userEvent.click(retry);
  expect(onRetryFailed).toHaveBeenCalledOnce();
  expect(onOpenGovernance).not.toHaveBeenCalled();
});

it("makes organizing source copies the primary action after a clean import", async () => {
  const onOpenGovernance = vi.fn();
  const onContinueLater = vi.fn();
  await renderSummary({
    results: cleanResults,
    manageableSourceCount: 2,
    onOpenGovernance,
    onContinueLater,
  });

  const organize = screen.getByRole("button", { name: "整理来源副本" });
  expect(organize).toHaveClass("sh-button--primary");
  expect(screen.getByRole("button", { name: "稍后处理" })).toBeVisible();
  // 说明文案讲清收益与后果：集中保存、删除原入口后 Agent 不再从原位置读取、
  // 之后可从集中库为 Agent 重新链接或复制；不承诺提升准确率。
  const note = screen.getByText(/集中保存/);
  expect(note.textContent).toContain("链接");
  expect(note.textContent).not.toContain("准确率");
  await userEvent.click(organize);
  expect(onOpenGovernance).toHaveBeenCalledOnce();
});

it("hides the organize entry when no source copies are manageable (online-only)", async () => {
  await renderSummary({ results: cleanResults, manageableSourceCount: 0 });

  expect(screen.queryByRole("button", { name: "整理来源副本" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "稍后处理" })).not.toBeInTheDocument();
  expect(screen.queryByText(/集中保存/)).not.toBeInTheDocument();
});

it("keeps retry as the only next step when failures come from an online-only import", async () => {
  const onRetryFailed = vi.fn();
  await renderSummary({
    results: [{ candidateId: "c", action: "copy", status: "failed", message: "写入失败" }],
    manageableSourceCount: 0,
    onRetryFailed,
  });

  expect(screen.getByRole("button", { name: "重试失败项" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "整理来源副本" })).not.toBeInTheDocument();
});

it("shows the online source locator instead of the cache path", async () => {
  await renderSummary({
    results: [{
      candidateId: "a",
      action: "reuse",
      status: "succeeded",
      message: "已导入",
      provenance: {
        agentClientId: null,
        originalPath: "C:/Users/demo/AppData/Local/skillhub/cache/repo",
        importedAt: "1700000002",
        sourceKind: "git",
        sourceLocator: "https://github.com/example/skills",
      },
    }],
  });

  fireEvent.click(screen.getByRole("button", { name: "查看成功和跳过明细" }));
  const line = screen.getByTestId("import-provenance");
  expect(line).toHaveTextContent("在线来源");
  expect(line).toHaveTextContent("https://github.com/example/skills");
  // 绝不显示本机缓存路径。
  expect(line.textContent).not.toContain("AppData");
  expect(line.textContent).not.toContain("cache");
});

it("labels plain local directories instead of guessing agent ownership in provenance", async () => {
  await renderSummary({
    results: [{
      candidateId: "a",
      action: "copy",
      status: "succeeded",
      message: "已导入",
      provenance: {
        agentClientId: null,
        originalPath: "/downloads/demo",
        importedAt: "1700000003",
        sourceKind: "local",
      },
    }],
  });

  fireEvent.click(screen.getByRole("button", { name: "查看成功和跳过明细" }));
  const line = screen.getByTestId("import-provenance");
  expect(line).toHaveTextContent("本地目录");
  expect(line).toHaveTextContent("路径：");
  expect(screen.queryByText(/来源未识别/)).not.toBeInTheDocument();
});
