import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
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
