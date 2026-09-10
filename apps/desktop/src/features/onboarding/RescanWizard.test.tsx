import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { RescanWizard } from "./RescanWizard";

it("shows the active library as read-only and never exposes activation controls", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const activateLibraryRoot = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18n}>
      <RescanWizard
        libraryPath="C:\SkillHub"
        operations={{
          completeOnboarding: async () => undefined,
          discoverAgents: async () => ({ targets: [] }),
          activateLibraryRoot,
        }}
        runtime={{
          getBootstrapView: async () => { throw new Error("unused"); },
          runInitializationScan: async () => ({
            kind: "completed",
            result: { generation: { generation: 1, observed_at: 1 }, roots: [], discovered: [], visited_paths: [], reparsed_count: 0, unchanged_count: 0, errors: [] },
          }),
        }}
      />
    </I18nextProvider>,
  );

  expect(screen.getByRole("heading", { name: "重新发现 Agent 与 Skill" })).toBeVisible();
  expect(screen.getByText("C:\\SkillHub")).toBeVisible();
  expect(screen.queryByRole("button", { name: "保存并继续" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "继续" }));
  expect(activateLibraryRoot).not.toHaveBeenCalled();
});

it("supports cancel and complete callbacks without completing onboarding or activating a library", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const user = userEvent.setup();
  const onCancel = vi.fn();
  const onComplete = vi.fn();
  const completeOnboarding = vi.fn(async () => undefined);
  const activateLibraryRoot = vi.fn(async () => undefined);

  render(
    <I18nextProvider i18n={i18n}>
      <RescanWizard
        libraryPath="C:\SkillHub"
        onCancel={onCancel}
        onComplete={onComplete}
        operations={{
          completeOnboarding,
          discoverAgents: async () => ({ targets: [] }),
          activateLibraryRoot,
        }}
        runtime={{
          getBootstrapView: async () => { throw new Error("unused"); },
          runInitializationScan: async () => ({
            kind: "completed",
            result: { generation: { generation: 1, observed_at: 1 }, roots: [], discovered: [], visited_paths: [], reparsed_count: 0, unchanged_count: 0, errors: [] },
          }),
        }}
      />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("button", { name: "取消并返回设置" }));
  expect(onCancel).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "识别 Agent" }));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "完成重新扫描" }));

  expect(onComplete).toHaveBeenCalledOnce();
  expect(completeOnboarding).not.toHaveBeenCalled();
  expect(activateLibraryRoot).not.toHaveBeenCalled();
});

it("shows a discovery error and retries without clearing the current library state", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const user = userEvent.setup();
  const discoverAgents = vi.fn()
    .mockRejectedValueOnce(new Error("Agent discovery failed"))
    .mockResolvedValueOnce({ targets: [] });

  render(
    <I18nextProvider i18n={i18n}>
      <RescanWizard
        libraryPath="C:\SkillHub"
        operations={{ completeOnboarding: async () => undefined, discoverAgents }}
        runtime={{ getBootstrapView: async () => { throw new Error("unused"); }, runInitializationScan: async () => { throw new Error("unused"); } }}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText("C:\\SkillHub")).toBeVisible();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "识别 Agent" }));

  expect(await screen.findByText("Agent discovery failed")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(discoverAgents).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Agent discovery failed")).not.toBeInTheDocument();
  expect(screen.getByText("没有发现可选择的兼容性目标。")).toBeVisible();
});

it("shows a scan error and retries without changing the current library state", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const user = userEvent.setup();
  const runInitializationScan = vi.fn()
    .mockRejectedValueOnce(new Error("Scan failed"))
    .mockResolvedValueOnce({
      kind: "completed" as const,
      result: { generation: { generation: 1, observed_at: 1 }, roots: [], discovered: [], visited_paths: [], reparsed_count: 0, unchanged_count: 0, errors: [] },
    });

  render(
    <I18nextProvider i18n={i18n}>
      <RescanWizard
        libraryPath="C:\SkillHub"
        operations={{ completeOnboarding: async () => undefined, discoverAgents: async () => ({ targets: [] }) }}
        runtime={{ getBootstrapView: async () => { throw new Error("unused"); }, runInitializationScan }}
      />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "识别 Agent" }));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "开始只读扫描" }));

  expect(await screen.findByText("Scan failed")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(runInitializationScan).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Scan failed")).not.toBeInTheDocument();
  expect(screen.getByText("C:\\SkillHub")).toBeVisible();
});
