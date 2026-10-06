import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { ImportCandidate, ImportSecurityPlan } from "./api";
import { SecurityDecisionSection } from "./SecurityDecisionSection";
import { parseSourceInput } from "./api";

// ---- W3-1（FB-003）：危险级安全风险的显式决策区块 ----
// 第 24 节（2026-10-06）：区块自 ConflictResolution.tsx 拆分至安全检测步，
// 呈现同步收口——危险级明细按规则聚合（规则 × 命中处数 + 首条位置，逐行
// 位置折叠为次级视图）、警告级发现不进入危险级决策列表且卡内汇总计数、
// 警告级名单按 Skill 身份去重并提供整体继续/整体跳过/逐个调整三档。
// 跨区块顺序断言（安全检测先于冲突处置）由 ImportWizard.test.tsx 覆盖。

const batchSource = await parseSourceInput("C:/incoming");

const securityPlan: ImportSecurityPlan = {
  "risky-1": {
    checkState: "warning",
    dangerCount: 3,
    findings: [
      {
        code: "security.destructive_command",
        file: "scripts/deploy.sh",
        lineStart: 12,
        productLevel: "danger",
      },
      {
        code: "security.destructive_command",
        file: "scripts/deploy.sh",
        lineStart: 19,
        productLevel: "danger",
      },
      {
        code: "security.elevation",
        file: "scripts/deploy.sh",
        lineStart: 27,
        productLevel: "danger",
      },
      {
        // §24：警告级发现携带在同一份摘要里，但不得进入危险级决策列表。
        code: "security.command_interpolation",
        file: "scripts/parse.sh",
        lineStart: 3,
        productLevel: "warning",
      },
    ],
    level: "danger",
    warningCount: 1,
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
  "warn-2": {
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
    // §24：同一 Skill 的第二来源条目——警告名单须按身份合并为一条。
    basicCheck: "warning",
    id: "warn-2",
    name: "Suspicious Fetch",
    ownership: "unknown",
    path: "C:/incoming/backup/suspicious-fetch",
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
  return new Map(
    candidates.map((candidate) => [candidate.id, { name: candidate.name, path: candidate.path }]),
  );
}

it("renders the danger security block with rule-aggregated findings and two explicit decisions", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onSecurityDecision = vi.fn();
  const user = userEvent.setup();
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

  const dangerHeading = screen.getByRole("heading", { name: "危险级安全风险（需要逐个决策）" });
  expect(dangerHeading).toBeVisible();

  // §24：明细按规则聚合——规则名 × 命中处数，附首条文件/行位置。
  const riskyRow = screen.getByText("Risky Deploy").closest("li") as HTMLElement;
  expect(within(riskyRow).getByText("包含破坏性命令（如强制删除、格式化）")).toBeVisible();
  expect(within(riskyRow).getByText("尝试提升权限执行命令")).toBeVisible();
  expect(within(riskyRow).getAllByText("命中 2 处")).toHaveLength(1);
  // 首条位置直接可见（在规则行内，而非只存在于折叠明细里）。
  const destructiveRule = within(riskyRow)
    .getByText("包含破坏性命令（如强制删除、格式化）")
    .closest("div") as HTMLElement;
  expect(within(destructiveRule).getByText("scripts/deploy.sh:12")).toBeVisible();
  expect(within(riskyRow).getByText("scripts/deploy.sh:27")).toBeVisible();

  // §24：警告级发现不进入危险级决策列表。
  expect(
    within(riskyRow).queryByText("命令字符串拼接，可能被注入额外命令"),
  ).not.toBeInTheDocument();

  // §24 裁决③（2026-10-06）：警告级发现不静默消失——危险卡内给出汇总提示，
  // 计数按 productLevel 口径，导入后照常写入预警。
  expect(
    within(riskyRow).getByText("另有警告级发现 1 处，导入后写入预警"),
  ).toBeVisible();

  // 多处命中提供逐行位置的次级视图；单处命中不显示无意义的入口。
  expect(within(riskyRow).getAllByText("查看逐条位置")).toHaveLength(1);
  const details = within(riskyRow).getByText("查看逐条位置").closest("details");
  expect(details).not.toBeNull();
  expect(details).not.toHaveAttribute("open");
  await user.click(within(details as HTMLElement).getByText("查看逐条位置"));
  expect(within(details as HTMLElement).getByText("scripts/deploy.sh:19")).toBeVisible();

  // 不渲染内部标识：候选 id 与 finding 结构字段不得裸露。
  expect(screen.queryByText("risky-1")).not.toBeInTheDocument();

  // 两个显式选项：仍然导入 / 不导入；初始都不选中。
  const proceed = screen.getByRole("radio", { name: "仍然导入（导入后需处理预警才能派发）" });
  const skip = screen.getByRole("radio", { name: "不导入" });
  expect(proceed).not.toBeChecked();
  expect(skip).not.toBeChecked();

  await user.click(proceed);
  expect(onSecurityDecision).toHaveBeenLastCalledWith("risky-1", "proceed");
});

it("omits the danger-card warning note when the candidate carries no warning-level findings", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const dangerousOnlyFindings = securityPlan["risky-1"].findings.filter(
    (finding) => finding.productLevel === "danger",
  );
  const plan: ImportSecurityPlan = {
    ...securityPlan,
    "risky-1": {
      ...securityPlan["risky-1"],
      findings: dangerousOnlyFindings,
      warningCount: 0,
    },
  };
  render(
    <I18nextProvider i18n={i18n}>
      <SecurityDecisionSection
        decisions={{}}
        labels={candidateLabels(securityCandidates)}
        onSecurityDecision={vi.fn()}
        summaries={plan}
      />
    </I18nextProvider>,
  );

  const riskyRow = screen.getByText("Risky Deploy").closest("li") as HTMLElement;
  expect(within(riskyRow).queryByText(/另有警告级发现/)).not.toBeInTheDocument();
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

it("deduplicates warning-level entries by skill identity with a default-import notice and three bulk tiers", async () => {
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
  // §24：计数按去重口径——两个同身份条目合并为一条，摘要只计 1 个技能。
  expect(
    within(warningSection as HTMLElement).getByText(
      "以下 1 个技能存在警告级提示，默认导入并写入预警（处理前不可派发）；可整体继续、整体跳过或逐个调整。",
    ),
  ).toBeVisible();
  // 同身份条目合并：名单只有一条 Suspicious Fetch，并显示来源数。
  expect(within(warningSection as HTMLElement).getAllByText("Suspicious Fetch")).toHaveLength(1);
  expect(within(warningSection as HTMLElement).getByText("2 个来源")).toBeVisible();
  // 放行级不渲染任何内容。
  expect(screen.queryByText("Safe Notes")).not.toBeInTheDocument();

  // §24：警告级不是逐条确认门禁——三档批量语义，默认档为整体继续；
  // 未进入“逐个调整”前没有逐条决策项。
  const tierRadio = within(warningSection as HTMLElement).getByRole("radio", {
    name: "全部继续导入（默认，导入并写入预警）",
  });
  expect(tierRadio).toBeChecked();
  expect(
    within(warningSection as HTMLElement).getByRole("radio", { name: "全部不导入" }),
  ).not.toBeChecked();
  expect(
    within(warningSection as HTMLElement).getByRole("radio", { name: "逐个调整" }),
  ).not.toBeChecked();
  expect(
    within(warningSection as HTMLElement).queryByRole("radio", { name: "仍然导入（导入后需处理预警才能派发）" }),
  ).not.toBeInTheDocument();
  expect(
    within(warningSection as HTMLElement).queryAllByRole("radio", { name: "不导入" }),
  ).toHaveLength(0);
});

it("applies the bulk warning tiers to every member of a deduplicated entry", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onSecurityDecision = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(
    <I18nextProvider i18n={i18n}>
      <SecurityDecisionSection
        decisions={{}}
        labels={candidateLabels(securityCandidates)}
        onSecurityDecision={onSecurityDecision}
        summaries={securityPlan}
      />
    </I18nextProvider>,
  );

  // 整体跳过：该身份组的全部来源条目都写入 skip。
  await user.click(screen.getByRole("radio", { name: "全部不导入" }));
  expect(onSecurityDecision).toHaveBeenCalledWith("warn-1", "skip");
  expect(onSecurityDecision).toHaveBeenCalledWith("warn-2", "skip");

  // 受控回显：全部 skip 时“全部不导入”档选中。
  rerender(
    <I18nextProvider i18n={i18n}>
      <SecurityDecisionSection
        decisions={{ "warn-1": "skip", "warn-2": "skip" }}
        labels={candidateLabels(securityCandidates)}
        onSecurityDecision={onSecurityDecision}
        summaries={securityPlan}
      />
    </I18nextProvider>,
  );
  expect(screen.getByRole("radio", { name: "全部不导入" })).toBeChecked();

  // 整体继续：回到默认导入语义，全部来源条目写入 proceed。
  await user.click(screen.getByRole("radio", { name: "全部继续导入（默认，导入并写入预警）" }));
  expect(onSecurityDecision).toHaveBeenCalledWith("warn-1", "proceed");
  expect(onSecurityDecision).toHaveBeenCalledWith("warn-2", "proceed");
});

it("reveals per-entry adjustments in the individual tier and applies them to the entry's sources", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onSecurityDecision = vi.fn();
  const user = userEvent.setup();
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

  const warningSection = screen
    .getByRole("heading", { name: "警告级安全提示" })
    .closest("section") as HTMLElement;
  await user.click(within(warningSection).getByRole("radio", { name: "逐个调整" }));

  // 逐个调整揭示逐条决策项；该条目的决策作用于其全部来源条目。
  await user.click(within(warningSection).getByRole("radio", { name: "不导入" }));
  expect(onSecurityDecision).toHaveBeenCalledWith("warn-1", "skip");
  expect(onSecurityDecision).toHaveBeenCalledWith("warn-2", "skip");

  // 逐条选择仍然导入同样写入 proceed。
  await user.click(
    within(warningSection).getByRole("radio", { name: "仍然导入（导入后需处理预警才能派发）" }),
  );
  expect(onSecurityDecision).toHaveBeenCalledWith("warn-1", "proceed");
  expect(onSecurityDecision).toHaveBeenCalledWith("warn-2", "proceed");
});

it("keeps the individual tier visible when decisions are mixed across entries", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onSecurityDecision = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18n}>
      <SecurityDecisionSection
        decisions={{ "warn-1": "skip", "warn-2": "proceed" }}
        labels={candidateLabels(securityCandidates)}
        onSecurityDecision={onSecurityDecision}
        summaries={securityPlan}
      />
    </I18nextProvider>,
  );

  const warningSection = screen
    .getByRole("heading", { name: "警告级安全提示" })
    .closest("section") as HTMLElement;

  // 混合决策只能出现在“逐个调整”档：档位回显 + 逐条决策项可见。
  expect(within(warningSection).getByRole("radio", { name: "逐个调整" })).toBeChecked();
  const proceed = within(warningSection).getByRole("radio", {
    name: "仍然导入（导入后需处理预警才能派发）",
  });
  const skip = within(warningSection).getByRole("radio", { name: "不导入" });
  expect(proceed).toBeInTheDocument();
  expect(skip).toBeInTheDocument();

  // 混合状态下条目没有预选（两个方向都不诚实），用户显式补齐。
  expect(proceed).not.toBeChecked();
  expect(skip).not.toBeChecked();
  await user.click(proceed);
  expect(onSecurityDecision).toHaveBeenCalledWith("warn-1", "proceed");
  expect(onSecurityDecision).toHaveBeenCalledWith("warn-2", "proceed");
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
