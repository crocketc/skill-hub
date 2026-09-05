import { fireEvent, render, screen } from "@testing-library/react";
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
  candidatePath: "C:/codex/skills/pdf-a",
  kind: "same_name",
  matchedSkillIds: ["skill-pdf", "skill-pdf-old"],
  summary: "同名 Skill 已存在",
  allowedActions: ["copy", "independent", "skip"],
  required: true,
};

const sameNameB: ImportConflict = {
  candidateId: "pdf-b",
  candidatePath: "C:/claude/skills/pdf-b",
  kind: "same_name",
  matchedSkillIds: ["skill-pdf"],
  summary: "同名 Skill 已存在",
  allowedActions: ["copy", "independent", "skip"],
  required: true,
};

it("applies one action to every conflict in a kind group at once", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onAction = vi.fn();
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
  fireEvent.click(screen.getByRole("button", { name: "复制到 SkillHub" }));

  expect(onAction).toHaveBeenCalledTimes(2);
  expect(onAction).toHaveBeenCalledWith("pdf-a", "copy");
  expect(onAction).toHaveBeenCalledWith("pdf-b", "copy");
});

it("shows which existing skills and paths each conflict involves", async () => {
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
