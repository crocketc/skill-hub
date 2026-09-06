import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { ImportConflict } from "./api";
import { ConflictResolution } from "./ConflictResolution";

const conflict: ImportConflict = {
  candidateId: "agent-pdf",
  kind: "agent_owned",
  summary: "目录已由 Agent 管理",
  allowedActions: ["takeover", "copy", "skip"],
  required: true,
};

it("keeps commit disabled until every required conflict has an action", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onAction = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[conflict]} actions={{}} onAction={onAction} onContinue={vi.fn()} onBack={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: "保留当前位置并纳入管理" }));
  expect(onAction).toHaveBeenCalledWith("agent-pdf", "takeover");
});

it("renders only the actions allowed by each conflict", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[conflict]} actions={{ "agent-pdf": "copy" }} onAction={vi.fn()} onContinue={vi.fn()} onBack={vi.fn()} />
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
    candidateId: "C:\\Users\\crock\\.claude\\skills\\pdf#pdf",
    candidateName: "pdf",
    candidatePath: "C:\\Users\\crock\\.claude\\skills\\pdf",
    kind: "same_name",
    matchedSkillIds: ["0f0a2c1e-6b7d-4c1a-9f2e-3d5a7b9c1e2f"],
    summary: "import.same_runtime_name_conflict",
    duplicateKind: "same_runtime_name_different_content",
    allowedActions: ["independent", "skip"],
    required: true,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[rawCoded]} actions={{}} onAction={vi.fn()} onContinue={vi.fn()} onBack={vi.fn()} />
    </I18nextProvider>,
  );

  // 面向用户的原因文案作为主要说明。
  expect(screen.getByText("运行时名称与已有 Skill 相同")).toBeVisible();
  // 候选显示名与来源路径可读。
  expect(screen.getByText("pdf")).toBeVisible();
  expect(screen.getByText("C:\\Users\\crock\\.claude\\skills\\pdf")).toBeVisible();
  // 原始 reason code 仅保留在次要排查文本（code 元素）中，不作为主要文案。
  const raw = screen.getByText("import.same_runtime_name_conflict");
  expect(raw.closest("code")).not.toBeNull();
  expect(raw.closest("strong")).toBeNull();
  // 内容差异信息（来自 duplicateKind）一并展示。
  expect(screen.getByText("运行时名称相同，但内容不同")).toBeVisible();
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
      <ConflictResolution conflicts={[unknown]} actions={{}} onAction={vi.fn()} onContinue={vi.fn()} onBack={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getByText("未知冲突类型（mystery_kind）")).toBeVisible();
});

it("describes the impact of every decision option", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[sameNameA]} actions={{}} onAction={vi.fn()} onContinue={vi.fn()} onBack={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getByText("复制到 SkillHub：将候选内容复制入库，已有 Skill 与其部署不会被覆盖")).toBeVisible();
  expect(screen.getByText("独立导入：以新身份存入库中，不覆盖已有 Skill")).toBeVisible();
  expect(screen.getByText("跳过：不导入该候选")).toBeVisible();
  // 影响说明不改变选项的可访问名称，决策仍由用户显式选择。
  expect(screen.getByRole("radio", { name: "独立导入" })).not.toBeChecked();
});

it("lists the existing skills and content difference a conflict involves", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ConflictResolution conflicts={[sameNameA]} actions={{}} onAction={vi.fn()} onContinue={vi.fn()} onBack={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getByText("C:/codex/skills/pdf-a")).toBeVisible();
  expect(screen.getByText("skill-pdf")).toBeVisible();
  expect(screen.getByText("skill-pdf-old")).toBeVisible();
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
        onContinue={vi.fn()}
        onBack={vi.fn()}
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
        onContinue={vi.fn()}
        onBack={vi.fn()}
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
        onContinue={vi.fn()}
        onBack={vi.fn()}
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
