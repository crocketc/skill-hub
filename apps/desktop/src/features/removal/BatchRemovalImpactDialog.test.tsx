import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { RemovalImpact } from "./api";
import { BatchRemovalImpactDialog } from "./BatchRemovalImpactDialog";

const impacts: RemovalImpact[] = [
  {
    combinations: ["Cleanup combo"],
    declaredDependencies: [],
    deployments: [{ id: "codex", label: "Codex", path: "C:/Codex", physicalId: "codex" }],
    dependentProjects: [],
    operationId: "delete-pdf",
    pinnedVersions: [],
    relatedSkills: [],
    skillId: "pdf",
    skillName: "PDF Reader",
    unknownExternalReferences: [],
  },
  {
    combinations: [],
    declaredDependencies: ["python 3.11 runtime"],
    deployments: [],
    dependentProjects: ["Demo Project"],
    operationId: "delete-docx",
    pinnedVersions: [{ projectId: "project-1", versionId: "sha256:vvvv" }],
    relatedSkills: ["Notes packager"],
    skillId: "docx",
    skillName: "DOCX Reader",
    unknownExternalReferences: ["/agents/root/notes"],
  },
];

async function renderDialog(props: Partial<Parameters<typeof BatchRemovalImpactDialog>[0]> = {}) {
  const i18n = await createSkillHubI18n(["en-US"]);
  const onConfirm = vi.fn();
  const merged = { impacts, onCancel: vi.fn(), onConfirm, ...props };
  render(
    <I18nextProvider i18n={i18n}>
      <BatchRemovalImpactDialog {...merged} />
    </I18nextProvider>,
  );
  return merged;
}

it("requires impact choices and a second click confirmation without typed phrases", async () => {
  const { onConfirm } = await renderDialog();

  expect(screen.getByText(/2 Skills are selected for deletion from the library\./)).toBeVisible();
  expect(screen.getByRole("button", { name: "Continue to force deletion" })).toBeDisabled();

  fireEvent.change(screen.getByRole("combobox", { name: "Deployment handling: Codex" }), {
    target: { value: "remove_deployment" },
  });

  // QA-001：二次点击确认取代 FORCE DELETE 文本输入——
  // 第一次点击"继续"只武装确认按钮，第二次点击才真正提交。
  expect(screen.queryByRole("textbox")).toBeNull();
  const proceed = screen.getByRole("button", { name: "Continue to force deletion" });
  fireEvent.click(proceed);
  expect(onConfirm).not.toHaveBeenCalled();

  const armed = screen.getByRole("button", { name: "Click again to confirm deleting 2 Skills" });
  fireEvent.click(armed);
  expect(onConfirm).toHaveBeenCalledWith({
    "delete-pdf": { codex: "remove_deployment" },
    "delete-docx": {},
  });
});

it("shows the extra impact dimensions per skill", async () => {
  await renderDialog();

  expect(screen.getByText(/Combinations: Cleanup combo/)).toBeVisible();
  expect(screen.getByText(/Demo Project/)).toBeVisible();
  expect(screen.getByText(/Declared dependencies: python 3\.11 runtime/)).toBeVisible();
  expect(screen.getByText(/Related skills: Notes packager/)).toBeVisible();
  expect(
    screen.getByText(/Unknown external references \(reported only, never modified\): \/agents\/root\/notes/),
  ).toBeVisible();
  expect(screen.getByText(/Pinned versions: 1/)).toBeVisible();
});

it("reports an executing state while the batch is submitting", async () => {
  await renderDialog({ submitting: true });

  const busy = screen.getByRole("status");
  expect(busy).toHaveTextContent("Deleting 2 Skills…");
  expect(screen.getByRole("button", { name: "Continue to force deletion" })).toBeDisabled();
});

it("keeps the non-atomic batch risk adjacent to the forced-deletion action", async () => {
  await renderDialog();

  const risk = screen.getByText(/not atomic/i);
  const actions = risk.closest("footer");
  expect(actions).not.toBeNull();
  expect(
    within(actions as HTMLElement).getByRole("button", { name: "Continue to force deletion" }),
  ).toBeInTheDocument();
});

it("states retention and the backup-only recovery path before batch deletion", async () => {
  await renderDialog();

  // P1-15：批量删除同样是“删除库中 Skill”对象——提交前固定说明
  // 保留什么（库外原文件）与恢复方式（仅事先导出的备份）。
  expect(screen.getByText(/Kept: files outside SkillHub are never touched/)).toBeVisible();
  expect(screen.getByText(/Recovery: deleting from the library cannot be undone/)).toBeVisible();
  expect(screen.getByText(/export a backup first/)).toBeVisible();
});
