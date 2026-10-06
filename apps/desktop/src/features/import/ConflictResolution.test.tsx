import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { ImportAction, ImportBatchAnalysis, ImportCandidate, ImportConflict, ImportSecurityPlan } from "./api";
import { ConflictResolution } from "./ConflictResolution";
import { parseSourceInput } from "./api";

const conflict: ImportConflict = {
  candidateId: "agent-pdf",
  kind: "agent_owned",
  summary: "目录已由 Agent 管理",
  allowedActions: ["takeover", "copy", "skip"],
  required: true,
};

// “提交前必须为每个必选冲突显式决策”的门槛语义已上移到向导底部操作区，
// 由 ImportWizard.test.tsx 的“keeps commit disabled until every required conflict has an explicit decision”覆盖。

it("renders only the actions allowed by each conflict", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[conflict]} actions={{ "agent-pdf": "copy" }} onAction={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getByRole("radio", { name: "复制到 SkillHub" })).toBeChecked();
  expect(screen.queryByRole("radio", { name: /覆盖/ })).not.toBeInTheDocument();
});

const sameNameA: ImportConflict = {
  candidateId: "pdf-a",
  candidateName: "pdf-a",
  candidatePath: "C:/codex/skills/pdf-a",
  kind: "same_name",
  matchedSkillIds: ["skill-pdf", "skill-pdf-old"],
  summary: "同名 Skill 已存在",
  allowedActions: ["copy", "independent", "skip"],
  required: true,
};

const sameNameB: ImportConflict = {
  candidateId: "pdf-b",
  candidateName: "pdf-b",
  candidatePath: "C:/claude/skills/pdf-b",
  kind: "same_name",
  matchedSkillIds: ["skill-pdf"],
  summary: "同名 Skill 已存在",
  allowedActions: ["copy", "independent", "skip"],
  required: true,
};

const exactDuplicate: ImportConflict = {
  candidateId: "dup-x",
  candidateName: "dup-skill",
  candidatePath: "C:/library/dup",
  kind: "exact_duplicate",
  matchedSkillIds: ["skill-dup"],
  summary: "import.exact_content_conflict",
  duplicateKind: "exact_content",
  allowedActions: ["reuse", "skip"],
  required: true,
};

it("shows a readable reason and candidate identity instead of raw reason codes", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const rawCoded: ImportConflict = {
    candidateId: "C:\\Users\\demo\\.claude\\skills\\pdf#pdf",
    candidateName: "pdf",
    candidatePath: "C:\\Users\\demo\\.claude\\skills\\pdf",
    kind: "same_name",
    matchedSkillIds: ["0f0a2c1e-6b7d-4c1a-9f2e-3d5a7b9c1e2f"],
    summary: "import.same_runtime_name_conflict",
    duplicateKind: "same_runtime_name_different_content",
    allowedActions: ["independent", "skip"],
    required: true,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[rawCoded]} actions={{}} onAction={vi.fn()} />
    </I18nextProvider>,
  );

  // 面向用户的原因文案作为主要说明。
  expect(screen.getByText("运行时名称与已有 Skill 相同")).toBeVisible();
  // 候选显示名与来源路径可读。
  expect(screen.getByText("pdf")).toBeVisible();
  expect(screen.getByText("C:\\Users\\demo\\.claude\\skills\\pdf")).toBeVisible();
  // 原始 reason code 仅保留在次要排查文本（code 元素）中，不作为主要文案。
  const raw = screen.getByText("import.same_runtime_name_conflict");
  expect(raw.closest("code")).not.toBeNull();
  expect(raw.closest("strong")).toBeNull();
  // 内容差异信息（来自 duplicateKind）一并展示。
  expect(screen.getByText("运行时名称相同，但内容不同")).toBeVisible();
});

it("shows matched Skill names and sources instead of UUIDs as the conflict identity", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const conflictWithReadableMatch: ImportConflict = {
    candidateId: "incoming-pdf",
    candidateName: "PDF Reader",
    candidatePath: "C:/incoming/pdf",
    kind: "same_name",
    matchedSkillIds: ["8b7f3d5d-9f25-4ed3-a5e1-uuid-only"],
    matchedSkills: [{
      id: "8b7f3d5d-9f25-4ed3-a5e1-uuid-only",
      displayName: "Library PDF Reader",
      runtimeName: "pdf-reader",
      source: "C:/library/pdf-reader",
    }],
    summary: "import.same_runtime_name_conflict",
    duplicateKind: "same_runtime_name_different_content",
    allowedActions: ["independent", "skip"],
    required: true,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[conflictWithReadableMatch]} actions={{}} onAction={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getByText("Library PDF Reader", { selector: "strong" })).toBeVisible();
  expect(screen.getByTitle("C:/library/pdf-reader")).toBeVisible();
  expect(screen.queryByText("8b7f3d5d-9f25-4ed3-a5e1-uuid-only")).not.toBeInTheDocument();
});

it("falls back to an honest label when a conflict kind has no mapping", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const unknown: ImportConflict = {
    candidateId: "mystery",
    candidateName: "mystery",
    kind: "mystery_kind" as ImportConflict["kind"],
    summary: "import.mystery_conflict",
    allowedActions: ["skip"],
    required: true,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[unknown]} actions={{}} onAction={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getByText("未知冲突类型（mystery_kind）")).toBeVisible();
});

it("describes the impact of every decision option", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[sameNameA]} actions={{}} onAction={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getByText("复制到 SkillHub：将候选内容复制入库，已有 Skill 及其目标副本不会被覆盖")).toBeVisible();
  expect(screen.getByText("独立导入：以新身份存入库中，不覆盖已有 Skill")).toBeVisible();
  expect(screen.getByText("跳过：不导入该候选")).toBeVisible();
  // 影响说明不改变选项的可访问名称，决策仍由用户显式选择。
  expect(screen.getByRole("radio", { name: "独立导入" })).not.toBeChecked();
});

it("lists the existing skills and content difference a conflict involves", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[sameNameA]} actions={{}} onAction={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getByText("C:/codex/skills/pdf-a")).toBeVisible();
  expect(screen.getByText("skill-pdf")).toBeVisible();
  expect(screen.getByText("skill-pdf-old")).toBeVisible();
});

it("folds technical diagnostics behind a details entry on every conflict", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[exactDuplicate]} actions={{}} onAction={vi.fn()} />
    </I18nextProvider>,
  );

  // 详情入口默认折叠；主信息（名称/路径/差异）保持展开可见。
  const summaries = screen.getAllByText("详情");
  const details = summaries[0].closest("details");
  expect(details).not.toBeNull();
  expect(details).not.toHaveAttribute("open");
  expect(screen.getByText("dup-skill")).toBeVisible();
  expect(screen.getByText("C:/library/dup")).toBeVisible();

  // 展开后提供完整技术诊断（reason code、差异类型）。
  await user.click(summaries[0]);
  expect(details).toHaveAttribute("open");
  expect(screen.getByText("import.exact_content_conflict")).toBeVisible();
  expect(screen.getByText("exact_content")).toBeVisible();
});

it("filters conflicts by reason and applies the batch action only to the filtered set", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onAction = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution
        conflicts={[sameNameA, exactDuplicate, sameNameB]}
        actions={{}}
        onAction={onAction}
      />
    </I18nextProvider>,
  );

  // 顶部筛选显示每个原因类别的数量。
  expect(screen.getByRole("button", { name: "全部（3）" })).toBeVisible();
  expect(screen.getByRole("button", { name: "名称重复（2）" })).toBeVisible();
  expect(screen.getByRole("button", { name: "完全重复（1）" })).toBeVisible();

  // 选中“名称重复”类别后只显示该类冲突。
  await user.click(screen.getByRole("button", { name: "名称重复（2）" }));
  expect(screen.queryByText("dup-skill")).not.toBeInTheDocument();
  expect(screen.getByText("pdf-a")).toBeVisible();
  expect(screen.getByText("pdf-b")).toBeVisible();

  // 批量控件在筛选视图内：选择处理方式 → 显示影响条数 → 确认应用。
  await user.selectOptions(screen.getByRole("combobox", { name: "选择处理方式" }), "copy");
  expect(screen.getByText("将应用到 2 项")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "应用" }));

  expect(onAction).toHaveBeenCalledTimes(2);
  expect(onAction).toHaveBeenCalledWith("pdf-a", "copy");
  expect(onAction).toHaveBeenCalledWith("pdf-b", "copy");
  expect(onAction).not.toHaveBeenCalledWith("dup-x", "copy");
});

it("keeps individual choices working while a category filter is active", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onAction = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution
        conflicts={[sameNameA, exactDuplicate]}
        actions={{}}
        onAction={onAction}
      />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("button", { name: "完全重复（1）" }));
  fireEvent.click(screen.getByRole("radio", { name: "跳过此候选项" }));

  expect(onAction).toHaveBeenCalledWith("dup-x", "skip");
});

it("applies one chosen action to every conflict of the filtered kind at once", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onAction = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution
        conflicts={[sameNameA, sameNameB]}
        actions={{}}
        onAction={onAction}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText("名称重复 · 共 2 项")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "名称重复（2）" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "选择处理方式" }), "copy");
  await user.click(screen.getByRole("button", { name: "应用" }));

  expect(onAction).toHaveBeenCalledTimes(2);
  expect(onAction).toHaveBeenCalledWith("pdf-a", "copy");
  expect(onAction).toHaveBeenCalledWith("pdf-b", "copy");
});

// ---- W2-2（FB-007）：批内分组区块 ----

const batchSource = await parseSourceInput("C:/incoming");
const batchCandidates: ImportCandidate[] = [
  {
    basicCheck: "passed",
    id: "notes-a",
    name: "Notes Sync",
    ownership: "unknown",
    path: "C:/incoming/notes-sync",
    source: batchSource,
  },
  {
    basicCheck: "passed",
    id: "notes-b",
    name: "Notes Sync",
    ownership: "unknown",
    path: "C:/incoming/backup/notes-sync",
    source: batchSource,
  },
  {
    basicCheck: "passed",
    id: "alpha-a",
    name: "Alpha",
    ownership: "unknown",
    path: "C:/codex/skills/alpha",
    source: batchSource,
  },
  {
    basicCheck: "passed",
    id: "alpha-b",
    name: "Alpha",
    ownership: "unknown",
    path: "C:/claude/skills/alpha",
    source: batchSource,
  },
];

const batchAnalysis: ImportBatchAnalysis = {
  sameContentGroups: [
    {
      keepCandidateId: "notes-a",
      normalizedRuntimeName: "notes sync",
      skipCandidateIds: ["notes-b"],
    },
  ],
  sameNameGroups: [
    { candidateIds: ["alpha-a", "alpha-b"], normalizedRuntimeName: "alpha" },
  ],
  signature: "sig-1",
};

function renderBatch(props: {
  actions: Record<string, string>;
  overrides?: Record<string, string>;
  onAction?: (candidateId: string, action: ImportAction) => void;
  onOverrideName?: (candidateId: string, name: string) => void;
  conflicts?: ImportConflict[];
}) {
  return render(
    <I18nextProvider i18n={i18nForBatch}>
      <ConflictResolution
        actions={props.actions as never}
        batchAnalysis={batchAnalysis}
        candidates={batchCandidates}
        conflicts={props.conflicts ?? []}
        onAction={props.onAction ?? vi.fn()}
        onOverrideName={props.onOverrideName ?? vi.fn()}
        overrides={props.overrides ?? {}}
      />
    </I18nextProvider>,
  );
}

let i18nForBatch: Awaited<ReturnType<typeof createSkillHubI18n>>;

it("renders the batch same-content group with the merge suggestion preselected", async () => {
  i18nForBatch = await createSkillHubI18n(["zh-CN"]);
  const onAction = vi.fn();
  renderBatch({
    actions: { "notes-a": "copy", "notes-b": "skip" },
    onAction,
  });

  // 批内分组区块在无库内冲突时也必须呈现。
  expect(screen.getByText("批内重复：内容与来源相同")).toBeVisible();
  expect(
    screen.getByText(/建议保留一项导入、其余跳过/),
  ).toBeVisible();
  // 建议角色标识：保留/跳过徽标。
  expect(screen.getByText("建议保留")).toBeVisible();
  expect(screen.getByText("建议跳过")).toBeVisible();
  // 建议已默认选中（keep=复制，其余=跳过）。
  const copyRadios = screen.getAllByRole("radio", { name: "复制到 SkillHub" });
  expect(copyRadios[0]).toBeChecked();
  expect(copyRadios[1]).not.toBeChecked();
  const skipRadios = screen.getAllByRole("radio", { name: "跳过此候选项" });
  expect(skipRadios[0]).not.toBeChecked();
  expect(skipRadios[1]).toBeChecked();
  // 建议可改：改选即回传逐项动作。
  fireEvent.click(skipRadios[0]);
  expect(onAction).toHaveBeenCalledWith("notes-a", "skip");
});

it("requires an explicit disposition for every batch same-name member with no default", async () => {
  i18nForBatch = await createSkillHubI18n(["zh-CN"]);
  renderBatch({ actions: {} });

  expect(screen.getByText("批内同名：内容不同")).toBeVisible();
  expect(screen.getByText(/必须逐项处置/)).toBeVisible();
  for (const radio of screen.getAllByRole("radio", { name: "独立导入" })) {
    expect(radio).not.toBeChecked();
  }
  for (const radio of screen.getAllByRole("radio", { name: "跳过此候选项" })) {
    expect(radio).not.toBeChecked();
  }
});

it("reveals an inline rename input for the independent disposition and reports collisions", async () => {
  i18nForBatch = await createSkillHubI18n(["zh-CN"]);
  const onOverrideName = vi.fn();
  const user = userEvent.setup();
  renderBatch({ actions: { "alpha-a": "independent" }, onOverrideName });

  const input = screen.getByLabelText("新名称");
  expect(input).toBeVisible();
  // 库内冲突展示名参与即时校验说明。
  expect(screen.getByText(/不能与批内其他候选或库内已有 Skill 重名/)).toBeVisible();

  await user.type(input, "A");
  expect(onOverrideName).toHaveBeenLastCalledWith("alpha-a", "A");
});

it("marks an empty override as invalid and keeps guidance visible", async () => {
  i18nForBatch = await createSkillHubI18n(["zh-CN"]);
  renderBatch({ actions: { "alpha-a": "independent" }, overrides: { "alpha-a": "  " } });

  const input = screen.getByLabelText("新名称");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText("请先填写新名称，再选择独立导入。")).toBeVisible();
});

it("marks batch-colliding overrides as invalid with a distinct message", async () => {
  i18nForBatch = await createSkillHubI18n(["zh-CN"]);
  renderBatch({
    actions: { "alpha-a": "independent" },
    overrides: { "alpha-a": "Alpha" },
  });

  expect(screen.getByLabelText("新名称")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText("该名称与批内其他候选重名，请换一个。")).toBeVisible();
});

it("marks library-colliding overrides as invalid with a distinct message", async () => {
  i18nForBatch = await createSkillHubI18n(["zh-CN"]);
  const libraryConflict: ImportConflict = {
    candidateId: "alpha-a",
    candidateName: "Alpha",
    kind: "same_name",
    matchedSkills: [
      {
        displayName: "Library Alpha",
        id: "lib-1",
        runtimeName: "Library Alpha",
      },
    ],
    summary: "import.same_runtime_name_conflict",
    allowedActions: ["independent", "skip"],
    required: true,
  };
  renderBatch({
    actions: { "alpha-a": "independent" },
    conflicts: [libraryConflict],
    overrides: { "alpha-a": "Library Alpha" },
  });

  expect(screen.getByLabelText("新名称")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText("该名称与库内已有 Skill 重名，请换一个。")).toBeVisible();
});

it("shows no invalid marking while the typed rename is fresh", async () => {
  i18nForBatch = await createSkillHubI18n(["zh-CN"]);
  renderBatch({
    actions: { "alpha-a": "independent" },
    overrides: { "alpha-a": "Alpha Prime" },
  });

  expect(screen.getByLabelText("新名称")).toHaveAttribute("aria-invalid", "false");
});

it("keeps both batch sections out of the way when the plan carries no batch analysis", async () => {
  i18nForBatch = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18nForBatch}>
      <ConflictResolution
        actions={{}}
        conflicts={[sameNameA]}
        onAction={vi.fn()}
      />
    </I18nextProvider>,
  );

  expect(screen.queryByText("批内重复：内容与来源相同")).not.toBeInTheDocument();
  expect(screen.queryByText("批内同名：内容不同")).not.toBeInTheDocument();
});

// ---- W3-1（FB-003）：危险级安全风险的显式决策区块（处置环节内联） ----
// §24（2026-10-06）：危险级明细按规则聚合（规则 × 命中处数，附首条位置），
// 逐行位置收进可展开次级视图；警告级发现不得进入危险级决策列表；警告级
// 名单按 Skill 身份去重并显示来源数，提供整体继续/整体跳过/逐个调整三档。

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

it("renders the danger security block above conflicts with rule-aggregated findings and two explicit decisions", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onSecurityDecision = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution
        actions={{}}
        candidates={securityCandidates}
        conflicts={[sameNameA]}
        onAction={vi.fn()}
        onSecurityDecision={onSecurityDecision}
        security={securityPlan}
        securityDecisions={{}}
      />
    </I18nextProvider>,
  );

  // 危险级区块置顶：风险先于冲突处置出现。
  const dangerHeading = screen.getByRole("heading", { name: "危险级安全风险（需要逐个决策）" });
  expect(dangerHeading).toBeVisible();
  const conflictRadio = screen.getByRole("radio", { name: "复制到 SkillHub" });
  expect(
    dangerHeading.compareDocumentPosition(conflictRadio) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

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
      <ConflictResolution
        actions={{}}
        candidates={securityCandidates}
        conflicts={[sameNameA]}
        onAction={vi.fn()}
        onSecurityDecision={vi.fn()}
        security={plan}
        securityDecisions={{}}
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
      <ConflictResolution
        actions={{}}
        candidates={securityCandidates}
        conflicts={[]}
        onAction={vi.fn()}
        onSecurityDecision={onSecurityDecision}
        security={securityPlan}
        securityDecisions={{ "risky-1": "skip" }}
      />
    </I18nextProvider>,
  );

  expect(screen.getByRole("radio", { name: "不导入" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "仍然导入（导入后需处理预警才能派发）" })).not.toBeChecked();

  rerender(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution
        actions={{}}
        candidates={securityCandidates}
        conflicts={[]}
        onAction={vi.fn()}
        onSecurityDecision={onSecurityDecision}
        security={securityPlan}
        securityDecisions={{ "risky-1": "proceed" }}
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
      <ConflictResolution
        actions={{}}
        candidates={securityCandidates}
        conflicts={[]}
        onAction={vi.fn()}
        security={securityPlan}
        securityDecisions={{}}
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
  const tierRadios = within(warningSection as HTMLElement).getByRole("radio", {
    name: "全部继续导入（默认，导入并写入预警）",
  });
  expect(tierRadios).toBeChecked();
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
      <ConflictResolution
        actions={{}}
        candidates={securityCandidates}
        conflicts={[]}
        onAction={vi.fn()}
        onSecurityDecision={onSecurityDecision}
        security={securityPlan}
        securityDecisions={{}}
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
      <ConflictResolution
        actions={{}}
        candidates={securityCandidates}
        conflicts={[]}
        onAction={vi.fn()}
        onSecurityDecision={onSecurityDecision}
        security={securityPlan}
        securityDecisions={{ "warn-1": "skip", "warn-2": "skip" }}
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
      <ConflictResolution
        actions={{}}
        candidates={securityCandidates}
        conflicts={[]}
        onAction={vi.fn()}
        onSecurityDecision={onSecurityDecision}
        security={securityPlan}
        securityDecisions={{}}
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
      <ConflictResolution
        actions={{}}
        candidates={securityCandidates}
        conflicts={[]}
        onAction={vi.fn()}
        onSecurityDecision={onSecurityDecision}
        security={securityPlan}
        securityDecisions={{ "warn-1": "skip", "warn-2": "proceed" }}
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
      <ConflictResolution
        actions={{}}
        candidates={securityCandidates}
        conflicts={[]}
        onAction={vi.fn()}
      />
    </I18nextProvider>,
  );

  expect(screen.queryByRole("heading", { name: "危险级安全风险（需要逐个决策）" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "警告级安全提示" })).not.toBeInTheDocument();
});
