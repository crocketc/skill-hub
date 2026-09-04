import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import type { ScanResult } from "../../api/bindings";
import { OnboardingWizard } from "./OnboardingWizard";

const defaultLibraryPath = "C:\\Users\\Test\\SkillHub\\skills";
const emptyScanResult: ScanResult = {
  generation: { generation: 1, observed_at: 1 },
  roots: [],
  discovered: [],
  visited_paths: [],
  reparsed_count: 0,
  unchanged_count: 0,
  errors: [],
};

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

it("requires compatibility discovery before the read-only scan and keeps back navigation", async () => {
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
            return { kind: "completed", result: emptyScanResult };
          },
        }}
      />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  expect(screen.getByRole("heading", { name: "识别兼容的 Agent" })).toBeVisible();
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  expect(discoverAgents).not.toHaveBeenCalled();

  await click(screen.getByLabelText("我确认这里只识别 Agent，不会部署技能"));
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
            return { kind: "completed", result: emptyScanResult };
          },
        }}
      />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByLabelText("我确认这里只识别 Agent，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
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
  await click(screen.getByLabelText("我确认这里只识别 Agent，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  expect(screen.getByText("此操作尚未连接到本机服务。不会创建目录、部署或导入任何技能。"))
    .toBeVisible();
  expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();
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
  await click(screen.getByLabelText("我确认这里只识别 Agent，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));

  expect(await screen.findByLabelText("Codex")).toBeVisible();
  expect(screen.getByLabelText("Missing Agent")).toBeDisabled();
  await click(screen.getByLabelText("Codex"));
  expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();
  await click(screen.getByLabelText("我确认所选目标只用于只读扫描，不会部署技能"));
  expect(screen.getByRole("button", { name: "继续" })).toBeEnabled();
});

it("selects all available targets and scans only the confirmed targets", async () => {
  const runInitializationScan = vi.fn(async () => ({ kind: "completed" as const, result: emptyScanResult }));
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
  await click(screen.getByLabelText("我确认这里只识别 Agent，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  await click(screen.getByRole("button", { name: "全选可用目标" }));
  await click(screen.getByLabelText("我确认所选目标只用于只读扫描，不会部署技能"));
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
  await click(screen.getByLabelText("我确认这里只识别 Agent，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "开始只读扫描" }));
  expect(screen.getByText("扫描已启动，正在执行。")).toBeVisible();
  expect(screen.getByText("op-1")).toBeVisible();

  await click(screen.getByRole("button", { name: "完成初始化" }));
  expect(onComplete).toHaveBeenCalledOnce();
  expect(completeOnboarding).toHaveBeenCalledOnce();
  expect(screen.getByText("初始化已完成")).toBeVisible();
});

it("completes initialization before opening the guided import flow", async () => {
  const completeOnboarding = vi.fn(async () => undefined);
  const onOpenImport = vi.fn();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const scanResult = {
    ...emptyScanResult,
    roots: ["C:\\Users\\Test\\.codex\\skills"],
    discovered: [{
      root: "C:\\Users\\Test\\.codex\\skills",
      relative_path: "alpha",
      path: "C:\\Users\\Test\\.codex\\skills\\alpha",
      marker: "SKILL.md",
      marker_size: 1,
      marker_modified_at: 1,
      size: 1,
      latest_modified_at: 1,
      fingerprint: "a",
      metadata_fingerprint: "b",
    }],
  };

  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        libraryPath={defaultLibraryPath}
        onOpenImport={onOpenImport}
        operations={{ completeOnboarding, discoverAgents: async () => ({ targets: [] }) }}
        runtime={{
          getBootstrapView: async () => { throw new Error("not used"); },
          runInitializationScan: async () => ({ kind: "completed" as const, result: scanResult }),
        }}
      />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByLabelText("我确认这里只识别 Agent，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "开始只读扫描" }));
  await click(screen.getByRole("button", { name: "完成初始化并进入批量导入" }));

  expect(completeOnboarding).toHaveBeenCalledWith({ libraryPath: defaultLibraryPath, skipped: false });
  expect(onOpenImport).toHaveBeenCalledWith(scanResult.roots);
});

it("includes the native error code when a scan is rejected", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        libraryPath={defaultLibraryPath}
        operations={{ completeOnboarding: async () => undefined, discoverAgents: async () => ({ targets: [] }) }}
        runtime={{
          getBootstrapView: async () => { throw new Error("not used"); },
          runInitializationScan: async () => {
            throw { code: "input.invalid" };
          },
        }}
      />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByLabelText("我确认这里只识别 Agent，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "开始只读扫描" }));

  expect(screen.getByText("无法完成扫描。现有技能和目录没有被修改。（错误代码：input.invalid）")).toBeVisible();
});

it("states when the native scan failure has no error code", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        libraryPath={defaultLibraryPath}
        operations={{ completeOnboarding: async () => undefined, discoverAgents: async () => ({ targets: [] }) }}
        runtime={{
          getBootstrapView: async () => { throw new Error("not used"); },
          runInitializationScan: async () => { throw new Error("native service failed"); },
        }}
      />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByLabelText("我确认这里只识别 Agent，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "开始只读扫描" }));

  expect(screen.getByText("无法完成扫描。现有技能和目录没有被修改。（本机服务未返回错误代码）")).toBeVisible();
});

it("offers to continue initialization while a slow scan keeps running", async () => {
  vi.useFakeTimers();
  try {
    const i18n = await createSkillHubI18n(["zh-CN"]);
    const pendingScan = new Promise<never>(() => undefined);
    render(
      <I18nextProvider i18n={i18n}>
        <OnboardingWizard
          libraryPath={defaultLibraryPath}
          operations={{ completeOnboarding: async () => undefined, discoverAgents: async () => ({ targets: [] }) }}
          runtime={{
            getBootstrapView: async () => { throw new Error("not used"); },
            runInitializationScan: async () => pendingScan,
          }}
        />
      </I18nextProvider>,
    );

    await click(screen.getByRole("button", { name: "继续" }));
    await click(screen.getByLabelText("我确认这里只识别 Agent，不会部署技能"));
    await click(screen.getByRole("button", { name: "识别 Agent" }));
    await click(screen.getByRole("button", { name: "继续" }));
    await click(screen.getByRole("button", { name: "开始只读扫描" }));
    expect(screen.queryByRole("button", { name: "转入后台，继续完成初始化" })).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("button", { name: "转入后台，继续完成初始化" })).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});
