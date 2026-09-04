import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import { OnboardingWizard } from "./OnboardingWizard";

const defaultLibraryPath = "C:\\Users\\Test\\SkillHub\\skills";

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

it("allows skipping only after explicitly confirming the visible default library", async () => {
  const completeOnboarding = vi.fn(async () => undefined);
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        libraryPath={defaultLibraryPath}
        operations={{ completeOnboarding, discoverAgents: async () => ({ targets: [] }) }}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText(defaultLibraryPath)).toBeVisible();
  await click(screen.getByRole("button", { name: "跳过初始化" }));
  expect(completeOnboarding).not.toHaveBeenCalled();
  expect(screen.getByText("将创建空集中库")).toBeVisible();

  await click(screen.getByRole("button", { name: "确认并跳过" }));
  expect(completeOnboarding).toHaveBeenCalledWith({
    libraryPath: defaultLibraryPath,
    skipped: true,
  });
});

it("keeps compatibility discovery opt-in and scan read-only while allowing back navigation", async () => {
  const discoverAgents = vi.fn(async () => ({ targets: [] }));
  const runInitializationScan = vi.fn(async (_scopeIds: string[]) => undefined);
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        libraryPath={defaultLibraryPath}
        operations={{ completeOnboarding: async () => undefined, discoverAgents }}
        runtime={{
          getBootstrapView: async () => {
            throw new Error("not used");
          },
          runInitializationScan: async (scopeIds) => {
            await runInitializationScan(scopeIds);
            return { kind: "completed" };
          },
        }}
      />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  expect(screen.getByRole("heading", { name: "识别兼容的 Agent" })).toBeVisible();
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  expect(discoverAgents).not.toHaveBeenCalled();

  await click(screen.getByLabelText("我确认此步骤只识别，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  expect(discoverAgents).toHaveBeenCalledOnce();

  await click(screen.getByRole("button", { name: "继续" }));
  expect(screen.getByRole("heading", { name: "扫描已有技能" })).toBeVisible();
  expect(screen.getByText("扫描只生成预览，不会移动、导入或部署技能。"))
    .toBeVisible();
  await click(screen.getByRole("button", { name: "开始只读扫描" }));
  expect(runInitializationScan).toHaveBeenCalledWith([]);

  await click(screen.getByRole("button", { name: "上一步" }));
  expect(screen.getByRole("heading", { name: "识别兼容的 Agent" })).toBeVisible();
});

it("lets users finish without scanning", async () => {
  const completeOnboarding = vi.fn(async () => undefined);
  const runInitializationScan = vi.fn(async (_scopeIds: string[]) => undefined);
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        libraryPath={defaultLibraryPath}
        operations={{ completeOnboarding, discoverAgents: async () => ({ targets: [] }) }}
        runtime={{
          getBootstrapView: async () => {
            throw new Error("not used");
          },
          runInitializationScan: async (scopeIds) => {
            await runInitializationScan(scopeIds);
            return { kind: "completed" };
          },
        }}
      />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "跳过扫描" }));

  expect(runInitializationScan).not.toHaveBeenCalled();
  expect(completeOnboarding).toHaveBeenCalledWith({
    libraryPath: defaultLibraryPath,
    skipped: false,
  });
});

it("keeps initialization unavailable when no exact native library path was injected", async () => {
  const completeOnboarding = vi.fn(async () => undefined);
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        operations={{ completeOnboarding, discoverAgents: async () => ({ targets: [] }) }}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText("无法确认默认集中库位置")).toBeVisible();
  expect(screen.getByRole("button", { name: "跳过初始化" })).toBeDisabled();
  expect(completeOnboarding).not.toHaveBeenCalled();
});

it("reports missing native discovery and completion seams without a fake success", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard libraryPath={defaultLibraryPath} />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByLabelText("我确认此步骤只识别，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  expect(screen.getByText("此操作尚未连接到本机服务。不会创建目录、部署或导入任何技能。"))
    .toBeVisible();

  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "完成初始化" }));
  expect(screen.getByText("此操作尚未连接到本机服务。不会创建目录、部署或导入任何技能。"))
    .toBeVisible();
  expect(screen.queryByText("初始化已完成")).not.toBeInTheDocument();
});

it("shows discovery targets without deploying and requires selection confirmation", async () => {
  const discoverAgents = vi.fn(async () => ({
    targets: [
      { id: "codex", label: "Codex", availability: "available" as const },
      { id: "missing", label: "Missing Agent", availability: "unavailable" as const },
    ],
  }));
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        libraryPath={defaultLibraryPath}
        operations={{ completeOnboarding: async () => undefined, discoverAgents }}
      />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByLabelText("我确认此步骤只识别，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));

  expect(await screen.findByLabelText("Codex")).toBeVisible();
  expect(screen.getByLabelText("Missing Agent")).toBeDisabled();
  await click(screen.getByLabelText("Codex"));
  expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();
  await click(screen.getByLabelText("我确认所选目标只保存兼容性选择，不会部署技能"));
  expect(screen.getByRole("button", { name: "继续" })).toBeEnabled();
});

it("selects all available targets and scans only the confirmed targets", async () => {
  const runInitializationScan = vi.fn(async () => ({ kind: "completed" as const }));
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        libraryPath={defaultLibraryPath}
        operations={{
          completeOnboarding: async () => undefined,
          discoverAgents: async () => ({ targets: [
            { id: "codex", label: "Codex", availability: "available" as const },
            { id: "claude", label: "Claude", availability: "available" as const },
            { id: "missing", label: "Missing", availability: "unavailable" as const },
          ] }),
        }}
        runtime={{ getBootstrapView: async () => { throw new Error("not used"); }, runInitializationScan }}
      />
    </I18nextProvider>,
  );
  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByLabelText("我确认此步骤只识别，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  await click(screen.getByRole("button", { name: "全选可用目标" }));
  await click(screen.getByLabelText("我确认所选目标只保存兼容性选择，不会部署技能"));
  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "开始只读扫描" }));
  expect(runInitializationScan).toHaveBeenCalledWith(["codex", "claude"]);
});

it("reports a scan operation as started and completes the wizard once", async () => {
  const completeOnboarding = vi.fn(async () => undefined);
  const onComplete = vi.fn();
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        libraryPath={defaultLibraryPath}
        onComplete={onComplete}
        operations={{ completeOnboarding, discoverAgents: async () => ({ targets: [] }) }}
        runtime={{
          getBootstrapView: async () => {
            throw new Error("not used");
          },
          runInitializationScan: async () => ({
            kind: "in_progress",
            operationId: "op-1",
            phase: "applying",
          }),
        }}
      />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "开始只读扫描" }));
  expect(screen.getByText("扫描已启动，正在执行。")).toBeVisible();
  expect(screen.getByText("op-1")).toBeVisible();

  await click(screen.getByRole("button", { name: "完成初始化" }));
  expect(onComplete).toHaveBeenCalledOnce();
  expect(completeOnboarding).toHaveBeenCalledOnce();
  expect(screen.getByText("初始化已完成")).toBeVisible();
});
