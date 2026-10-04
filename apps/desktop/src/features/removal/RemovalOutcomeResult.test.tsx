import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { Location } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { RemovalResult } from "./api";
import { RemovalOutcomeResult } from "./RemovalOutcomeResult";

let lastLocation: Location | undefined;
function LocationProbe() {
  lastLocation = useLocation();
  return null;
}

/** K2 逐项结果：字段与生成绑定 DeploymentRemovalResult/RemovalResult 的桌面映射一致。 */
const targetLabels: Record<string, { label?: string; path?: string | null }> = {
  "dep-1": { label: "Codex CLI", path: "C:/Users/demo/.codex/skills/pdf-reader" },
  "dep-2": { label: "Claude Code", path: "C:/Users/demo/.claude/skills/pdf-reader" },
  "dep-3": { label: "共享目录 Aurora", path: "C:/shared/skills/pdf-reader" },
  "dep-4": { label: "OpenCode", path: "C:/Users/demo/.opencode/skills/pdf-reader" },
};

function resultWith(overrides: Partial<RemovalResult> = {}): RemovalResult {
  return {
    centralSkillDeleted: false,
    state: "partially_committed",
    recoveryOperationId: "op-restore-1",
    centralDeleteError: "internal.error",
    items: [
      { deploymentId: "dep-1", status: "applied" },
      { deploymentId: "dep-2", status: "applied" },
      { deploymentId: "dep-3", status: "failed", errorCode: "deployment.ownership_mismatch" },
    ],
    ...overrides,
  };
}

function renderResult(result: RemovalResult, onContinue?: () => void, continuing = false) {
  return createSkillHubI18n(["zh-CN"]).then((i18n) =>
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/skills/pdf-reader"]}>
          <Routes>
            <Route
              element={
                <>
                  <RemovalOutcomeResult continuing={continuing} onContinue={onContinue} result={result} targetLabels={targetLabels} />
                  <LocationProbe />
                </>
              }
              path="*"
            />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    ),
  );
}

describe("RemovalOutcomeResult", () => {
  it("lists applied, failed and not-attempted targets in separate groups with an honest partial title", async () => {
    await renderResult(resultWith({
      centralDeleteError: null,
      recoveryOperationId: null,
      items: [
        { deploymentId: "dep-1", status: "applied" },
        { deploymentId: "dep-2", status: "applied" },
        { deploymentId: "dep-3", status: "failed", errorCode: "deployment.ownership_mismatch" },
        { deploymentId: "dep-4", status: "pending" },
      ],
    }));

    // 终态标题如实：部分成功不是全部完成，中央 Skill 尚未删除必须可见；
    // 未尝试项计入「未删除」总数，不在标题里冒充已处理。
    expect(screen.getByTestId("removal-outcome-title")).toHaveTextContent(
      "已删除 2 个目标，2 个未删除；集中库 Skill 尚未删除。",
    );
    // 三态分列：同名布局槽位、互不混排。
    const appliedGroup = screen.getByTestId("removal-outcome-applied");
    expect(appliedGroup).toHaveTextContent("Codex CLI");
    expect(appliedGroup).toHaveTextContent("Claude Code");
    expect(appliedGroup).not.toHaveTextContent("共享目录 Aurora");
    const failedGroup = screen.getByTestId("removal-outcome-failed");
    expect(failedGroup).toHaveTextContent("共享目录 Aurora");
    expect(failedGroup).not.toHaveTextContent("Codex CLI");
    // pending 排在失败组之后，且文案区分「失败」与「未尝试」。
    const pendingGroup = screen.getByTestId("removal-outcome-pending");
    expect(pendingGroup).toHaveTextContent("OpenCode");
    expect(pendingGroup).toHaveTextContent("未尝试");
    expect(pendingGroup).not.toHaveTextContent("共享目录 Aurora");
    expect(failedGroup.compareDocumentPosition(pendingGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks the central-delete failure and navigates the recovery entry to the recovery center", async () => {
    await renderResult(resultWith());

    // K2 故障矩阵：delete_skill 失败 → 关系决定已执行、中央仍在，
    // 明示「目标已回收，中央 Skill 未删除」并提供恢复入口。
    // 注意：本用例保留中央失败事实，标题优先于逐项 partial 说明。
    expect(screen.getByTestId("removal-outcome-title")).toHaveTextContent("目标已回收，中央 Skill 未删除");
    const recoveryButton = screen.getByTestId("removal-outcome-recovery");
    expect(recoveryButton).toHaveTextContent("打开恢复中心");
    await userEvent.setup().click(recoveryButton);
    expect(lastLocation?.pathname).toBe("/recovery");
    expect(lastLocation?.search).toContain("operationId=op-restore-1");
  });

  it("maps a known error code to readable copy without leaking the raw enum", async () => {
    await renderResult(resultWith());

    // 已知错误码 → 统一 presenter 映射的可读原因；原始错误码不出现。
    const failedGroup = screen.getByTestId("removal-outcome-failed");
    expect(failedGroup).toHaveTextContent("删除失败：目标当前内容与部署关系不匹配。");
    expect(failedGroup).not.toHaveTextContent("deployment.ownership_mismatch");
  });

  it("falls back to readable copy for an unknown error code without crashing or leaking the enum", async () => {
    await renderResult(resultWith({
      state: "failed",
      centralDeleteError: null,
      recoveryOperationId: null,
      items: [{ deploymentId: "dep-9", status: "failed", errorCode: "removal.future_unknown_code" }],
    }));

    const fallbackGroup = screen.getByTestId("removal-outcome-failed");
    expect(fallbackGroup).toHaveTextContent("删除失败，可继续处理或稍后重试。");
    expect(fallbackGroup).not.toHaveTextContent("removal.future_unknown_code");
  });

  it("offers the continue (re-confirm) entry when targets failed or were not attempted", async () => {
    const onContinue = vi.fn();
    await renderResult(resultWith({
      items: [
        { deploymentId: "dep-1", status: "failed", errorCode: "deployment.ownership_mismatch" },
        { deploymentId: "dep-2", status: "pending" },
      ],
    }), onContinue);

    const continueButton = screen.getByTestId("removal-outcome-continue");
    expect(continueButton).toHaveTextContent("继续处理（重新确认）");
    await userEvent.setup().click(continueButton);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("renders an applied outcome without failure groups or continue entry", async () => {
    await renderResult(resultWith({
      centralSkillDeleted: true,
      state: "committed",
      centralDeleteError: null,
      recoveryOperationId: null,
      items: [
        { deploymentId: "dep-1", status: "applied" },
        { deploymentId: "dep-2", status: "applied" },
      ],
    }));

    expect(screen.getByTestId("removal-outcome-title")).toHaveTextContent("2 个目标已删除。");
    expect(screen.queryByTestId("removal-outcome-continue")).not.toBeInTheDocument();
    expect(screen.queryByTestId("removal-outcome-failed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("removal-outcome-pending")).not.toBeInTheDocument();
    expect(screen.queryByTestId("removal-outcome-recovery")).not.toBeInTheDocument();
  });
});
