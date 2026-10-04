import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { RemovalOutcomeResult, type RemovalOutcome } from "./RemovalOutcomeResult";

function renderOutcome(outcome: RemovalOutcome, onContinue?: () => void) {
  return createSkillHubI18n(["zh-CN"]).then((i18n) =>
    render(
      <I18nextProvider i18n={i18n}>
        <RemovalOutcomeResult onContinue={onContinue} outcome={outcome} />
      </I18nextProvider>,
    ),
  );
}

function outcomeWith(overrides: Partial<RemovalOutcome> = {}): RemovalOutcome {
  return {
    // K2 接线项：形态对齐 RelationGovernanceBatchOutcome；字段命名待
    // A 侧扩展 DeploymentRemovalResult 的提案落地后与生成绑定对齐。
    operation_id: "op-delete-1",
    state: "partially_applied",
    items: [
      {
        deployment_id: "dep-1",
        label: "Codex CLI",
        path: "C:/Users/demo/.codex/skills/pdf-reader",
        state: "applied",
        error_code: null,
        detail: null,
        retryable: false,
      },
      {
        deployment_id: "dep-2",
        label: "Claude Code",
        path: "C:/Users/demo/.claude/skills/pdf-reader",
        state: "applied",
        error_code: null,
        detail: null,
        retryable: false,
      },
      {
        deployment_id: "dep-3",
        label: "共享目录 Aurora",
        path: "C:/shared/skills/pdf-reader",
        state: "failed",
        error_code: "removal.target_locked",
        detail: "目标目录正被另一个程序占用",
        retryable: true,
      },
    ],
    applied_count: 2,
    failed_count: 1,
    ...overrides,
  };
}

describe("RemovalOutcomeResult", () => {
  it("lists applied and failed targets in separate groups with an honest partial title", async () => {
    await renderOutcome(outcomeWith());

    // 终态标题如实：部分成功不是全部完成，中央 Skill 未删除必须可见。
    expect(screen.getByTestId("removal-outcome-title")).toHaveTextContent(
      "已删除 2 个目标，1 个未删除；集中库 Skill 尚未删除。",
    );
    // 成功项/失败项分列：同名布局槽位、互不混排。
    const appliedGroup = screen.getByTestId("removal-outcome-applied");
    expect(appliedGroup).toHaveTextContent("Codex CLI");
    expect(appliedGroup).toHaveTextContent("Claude Code");
    expect(appliedGroup).not.toHaveTextContent("共享目录 Aurora");
    const failedGroup = screen.getByTestId("removal-outcome-failed");
    expect(failedGroup).toHaveTextContent("共享目录 Aurora");
    expect(failedGroup).not.toHaveTextContent("Codex CLI");
  });

  it("shows a readable reason for each failed target instead of the raw error code", async () => {
    await renderOutcome(outcomeWith());

    const failedGroup = screen.getByTestId("removal-outcome-failed");
    expect(failedGroup).toHaveTextContent("原因：目标目录正被另一个程序占用");
    // 不裸露内部枚举：原始错误码不出现在用户界面。
    expect(failedGroup).not.toHaveTextContent("removal.target_locked");
  });

  it("falls back to readable copy when a failed target carries only an unknown error code", async () => {
    await renderOutcome(outcomeWith({
      state: "failed",
      applied_count: 0,
      failed_count: 1,
      items: [{
        deployment_id: "dep-9",
        label: "未知目标",
        path: null,
        state: "failed",
        error_code: "removal.future_unknown_code",
        detail: null,
        retryable: true,
      }],
    }));

    const failedGroup = screen.getByTestId("removal-outcome-failed");
    expect(failedGroup).toHaveTextContent("删除失败，可继续处理或稍后重试。");
    expect(failedGroup).not.toHaveTextContent("removal.future_unknown_code");
  });

  it("offers the continue (re-confirm) entry for failed targets and reports re-checking while busy", async () => {
    const onContinue = vi.fn();
    const { rerender } = await renderOutcome(outcomeWith(), onContinue);

    const continueButton = screen.getByTestId("removal-outcome-continue");
    expect(continueButton).toHaveTextContent("继续处理（重新确认）");
    await userEvent.setup().click(continueButton);
    expect(onContinue).toHaveBeenCalledTimes(1);

    // 继续处理期间按钮禁用并播报「正在重新核对…」，避免重复触发。
    rerender(
      <I18nextProvider i18n={(await createSkillHubI18n(["zh-CN"])) as never}>
        <RemovalOutcomeResult continuing onContinue={onContinue} outcome={outcomeWith()} />
      </I18nextProvider>,
    );
    expect(screen.getByTestId("removal-outcome-continue")).toBeDisabled();
  });

  it("renders an applied outcome without a continue entry", async () => {
    await renderOutcome(outcomeWith({
      state: "applied",
      failed_count: 0,
      items: outcomeWith().items.map((item) => ({ ...item, state: "applied" as const })),
    }));

    expect(screen.getByTestId("removal-outcome-title")).toHaveTextContent("2 个目标已删除。");
    expect(screen.queryByTestId("removal-outcome-continue")).not.toBeInTheDocument();
    expect(screen.queryByTestId("removal-outcome-failed")).not.toBeInTheDocument();
  });
});
