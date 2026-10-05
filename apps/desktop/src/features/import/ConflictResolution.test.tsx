import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { ImportAction, ImportBatchAnalysis, ImportCandidate, ImportConflict } from "./api";
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
