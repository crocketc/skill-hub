import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { ImportCandidate, ImportSecurityPlan } from "./api";
import { SecurityDecisionSection } from "./SecurityDecisionSection";
import { parseSourceInput } from "./api";

// ---- W3-1（FB-003）：危险级安全风险的显式决策区块 ----
// 第 24 节：区块自 ConflictResolution.tsx 原样搬迁至安全检测步；
// 这组用例随组件迁移，逐条断言保持不变（跨区块置顶断言改由
// ImportWizard.test.tsx 的分步结构覆盖：安全检测先于冲突处置）。

const batchSource = await parseSourceInput("C:/incoming");

const securityPlan: ImportSecurityPlan = {
  "risky-1": {
    checkState: "warning",
    dangerCount: 2,
    findings: [
      {
        code: "security.destructive_command",
        file: "scripts/deploy.sh",
        lineStart: 12,
        productLevel: "danger",
      },
      {
        code: "security.elevation",
        file: "scripts/deploy.sh",
        lineStart: 27,
        productLevel: "danger",
      },
    ],
    level: "danger",
    warningCount: 0,
  },
  "warn-1": {
    checkState: "warning",
    dangerCount: 0,
    findings: [
      {
        code: "security.possible_plaintext_credential",
        file: "SKILL.md",
        lineStart: 18,
        productLevel: "warning",
      },
    ],
    level: "warning",
    warningCount: 1,
  },
  "safe-1": {
    checkState: "passed",
    dangerCount: 0,
    findings: [],
    level: "pass",
    warningCount: 0,
  },
};

const securityCandidates: ImportCandidate[] = [
  {
    basicCheck: "warning",
    id: "risky-1",
    name: "Risky Deploy",
    ownership: "unknown",
    path: "C:/incoming/risky-deploy",
    source: batchSource,
  },
  {
    basicCheck: "warning",
    id: "warn-1",
    name: "Suspicious Fetch",
    ownership: "unknown",
    path: "C:/incoming/suspicious-fetch",
    source: batchSource,
  },
  {
    basicCheck: "passed",
    id: "safe-1",
    name: "Safe Notes",
    ownership: "unknown",
    path: "C:/incoming/safe-notes",
    source: batchSource,
  },
];

function candidateLabels(candidates: ImportCandidate[]) {
  return new Map(candidates.map((candidate) => [candidate.id, { name: candidate.name, path: candidate.path }]));
}

it("renders the danger security block with full findings and two explicit decisions", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onSecurityDecision = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <SecurityDecisionSection
        decisions={{}}
        labels={candidateLabels(securityCandidates)}
        onSecurityDecision={onSecurityDecision}
        summaries={securityPlan}
      />
    </I18nextProvider>,
  );

  // 危险级区块标题与完整发现明细：候选名 + 可读规则名 + 文件/行号。
  const dangerHeading = screen.getByRole("heading", { name: "危险级安全风险（需要逐个决策）" });
  expect(dangerHeading).toBeVisible();
  expect(screen.getByText("Risky Deploy")).toBeVisible();
  expect(screen.getByText("包含破坏性命令（如强制删除、格式化）")).toBeVisible();
  expect(screen.getByText("尝试提升权限执行命令")).toBeVisible();
  expect(screen.getByText("scripts/deploy.sh:12")).toBeVisible();
  expect(screen.getByText("scripts/deploy.sh:27")).toBeVisible();

  // 不渲染内部标识：候选 id 与 finding 结构字段不得裸露。
  expect(screen.queryByText("risky-1")).not.toBeInTheDocument();

  // 两个显式选项：仍然导入 / 不导入；初始都不选中。
  const proceed = screen.getByRole("radio", { name: "仍然导入（导入后需处理预警才能派发）" });
  const skip = screen.getByRole("radio", { name: "不导入" });
  expect(proceed).not.toBeChecked();
  expect(skip).not.toBeChecked();

  await userEvent.click(proceed);
  expect(onSecurityDecision).toHaveBeenLastCalledWith("risky-1", "proceed");
});

it("reflects the controlled security decision and switches between proceed and skip", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onSecurityDecision = vi.fn();
  const { rerender } = render(
    <I18nextProvider i18n={i18n}>
      <SecurityDecisionSection
        decisions={{ "risky-1": "skip" }}
        labels={candidateLabels(securityCandidates)}
        onSecurityDecision={onSecurityDecision}
        summaries={securityPlan}
      />
    </I18nextProvider>,
  );

  expect(screen.getByRole("radio", { name: "不导入" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "仍然导入（导入后需处理预警才能派发）" })).not.toBeChecked();

  rerender(
    <I18nextProvider i18n={i18n}>
      <SecurityDecisionSection
        decisions={{ "risky-1": "proceed" }}
        labels={candidateLabels(securityCandidates)}
        onSecurityDecision={onSecurityDecision}
        summaries={securityPlan}
      />
    </I18nextProvider>,
  );
  expect(screen.getByRole("radio", { name: "仍然导入（导入后需处理预警才能派发）" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "不导入" })).not.toBeChecked();
});

it("aggregates warning-level candidates into one notice without per-item choices", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <SecurityDecisionSection
        decisions={{}}
        labels={candidateLabels(securityCandidates)}
        summaries={securityPlan}
      />
    </I18nextProvider>,
  );

  const warningHeading = screen.getByRole("heading", { name: "警告级安全提示" });
  const warningSection = warningHeading.closest("section");
  expect(warningSection).not.toBeNull();
  expect(
    within(warningSection as HTMLElement).getByText(
      "以下 1 个技能存在警告级提示，将正常导入并进入预警状态（处理前不可派发）。",
    ),
  ).toBeVisible();
  expect(within(warningSection as HTMLElement).getByText("Suspicious Fetch")).toBeVisible();
  // 警告级没有逐项选择。
  expect(within(warningSection as HTMLElement).queryAllByRole("radio")).toHaveLength(0);

  // 放行级不渲染任何内容。
  expect(screen.queryByText("Safe Notes")).not.toBeInTheDocument();
});

it("renders no security block when the plan carries no security summaries", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <SecurityDecisionSection
        decisions={{}}
        labels={candidateLabels(securityCandidates)}
        summaries={{}}
      />
    </I18nextProvider>,
  );

  expect(screen.queryByRole("heading", { name: "危险级安全风险（需要逐个决策）" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "警告级安全提示" })).not.toBeInTheDocument();
});
