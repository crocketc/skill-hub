import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { OnboardingOperations } from "../bootstrap/api";
import { RestoreStep } from "./RestoreStep";

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

function baseOperations(overrides: Partial<OnboardingOperations>): OnboardingOperations {
  return {
    completeOnboarding: async () => undefined,
    discoverAgents: async () => ({ targets: [] }),
    ...overrides,
  };
}

it("shows the native error code when preparing the restore plan fails", async () => {
  const operations = baseOperations({
    pickDirectory: async () => "C:\\backup.skillhub",
    prepareRestore: async () => {
      throw { code: "backup.plan_failed", severity: "error", params: {}, actions: [] };
    },
  });
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <RestoreStep operations={operations} onBack={() => undefined} onComplete={() => undefined} />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "选择备份目录" }));

  expect(
    await screen.findByText("操作失败（backup.plan_failed）。请稍后重试或重新打开页面。"),
  ).toBeVisible();
  expect(screen.queryByText(/尚未连接到本机服务/)).not.toBeInTheDocument();
});

it("shows the native error code when committing the restore fails", async () => {
  const operations = baseOperations({
    pickDirectory: async () => "C:\\backup.skillhub",
    prepareRestore: async () => ({
      format_version: 1,
      skills: 1,
      deployments_requiring_rediscovery: 0,
      conflicts: [],
    }),
    commitRestore: async () => {
      throw { code: "backup.commit_failed", severity: "error", params: {}, actions: [] };
    },
  });
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <RestoreStep operations={operations} onBack={() => undefined} onComplete={() => undefined} />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "选择备份目录" }));
  await click(await screen.findByRole("button", { name: "恢复并继续" }));

  expect(
    await screen.findByText("操作失败（backup.commit_failed）。请稍后重试或重新打开页面。"),
  ).toBeVisible();
  expect(screen.queryByText(/尚未连接到本机服务/)).not.toBeInTheDocument();
});

it("surfaces conflicts for per-item decisions instead of silently skipping", async () => {
  const commitRestore = vi.fn().mockResolvedValue({
    skills_restored: 1,
    skills_skipped: 0,
    deployments_requiring_rediscovery: 0,
  });
  const operations = baseOperations({
    pickDirectory: async () => "C:\\backup.skillhub",
    prepareRestore: async () => ({
      format_version: 1,
      skills: 2,
      deployments_requiring_rediscovery: 0,
      conflicts: [
        { skill_id: "skill-pdf", kind: "existing_skill", detail: "同名 Skill 已存在" },
        { skill_id: "skill-notes", kind: "existing_skill", detail: "同名 Skill 已存在" },
      ],
    }),
    commitRestore,
  });
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <RestoreStep operations={operations} onBack={() => undefined} onComplete={() => undefined} />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "选择备份目录" }));
  await screen.findByText(/skill-pdf/);
  // Every conflict needs an explicit decision before committing.
  expect(screen.getByRole("button", { name: "恢复并继续" })).toBeDisabled();

  await act(async () => {
    fireEvent.change(screen.getByLabelText("skill-pdf 的处理方式"), { target: { value: "overwrite" } });
    fireEvent.change(screen.getByLabelText("skill-notes 的处理方式"), { target: { value: "skip" } });
  });

  await click(screen.getByRole("button", { name: "恢复并继续" }));
  await waitFor(() =>
    expect(commitRestore).toHaveBeenCalledWith("C:\\backup.skillhub", [
      { skill_id: "skill-pdf", decision: "overwrite" },
      { skill_id: "skill-notes", decision: "skip" },
    ]),
  );
});

it("blocks committing when the backup contains invalid portable data", async () => {
  const commitRestore = vi.fn();
  const operations = baseOperations({
    pickDirectory: async () => "C:\\backup.skillhub",
    prepareRestore: async () => ({
      format_version: 1,
      skills: 1,
      deployments_requiring_rediscovery: 0,
      conflicts: [{ skill_id: null, kind: "invalid_portable_data", detail: "损坏的清单" }],
    }),
    commitRestore,
  });
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <RestoreStep operations={operations} onBack={() => undefined} onComplete={() => undefined} />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "选择备份目录" }));
  expect(await screen.findByText("备份包含无效便携数据，无法自动恢复。")).toBeVisible();
  expect(screen.getByRole("button", { name: "恢复并继续" })).toBeDisabled();
  expect(commitRestore).not.toHaveBeenCalled();
});

it("previews and commits first-run restore against the selected target library", async () => {
  const prepareInitialRestore = vi.fn().mockResolvedValue({
    format_version: 1,
    skills: 1,
    deployments_requiring_rediscovery: 0,
    conflicts: [],
  });
  const commitInitialRestore = vi.fn().mockResolvedValue({
    skills_restored: 1,
    skills_skipped: 0,
    deployments_requiring_rediscovery: 0,
  });
  const pickDirectory = vi
    .fn<() => Promise<string | null>>()
    .mockResolvedValueOnce("D:\\SkillHub\\target")
    .mockResolvedValueOnce("C:\\backup.skillhub");
  const operations = baseOperations({ pickDirectory, prepareInitialRestore, commitInitialRestore });
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <RestoreStep operations={operations} libraryPath="C:\\Suggested" onBack={() => undefined} onComplete={() => undefined} />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "选择其他目标目录" }));
  await click(screen.getByRole("button", { name: "选择备份目录" }));
  await screen.findByText("发现 1 个可恢复技能");
  await click(screen.getByRole("button", { name: "恢复并继续" }));

  expect(prepareInitialRestore).toHaveBeenCalledWith("C:\\backup.skillhub", "D:\\SkillHub\\target");
  expect(commitInitialRestore).toHaveBeenCalledWith("C:\\backup.skillhub", "D:\\SkillHub\\target", []);
});
