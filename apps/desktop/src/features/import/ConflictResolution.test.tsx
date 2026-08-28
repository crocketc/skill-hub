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
