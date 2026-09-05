import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import type { RestoreDecision, RestorePlan, RestoreResult, ScanResult } from "../../api/bindings";
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

interface Operations {
  completeOnboarding: (input: { libraryPath: string; skipped: boolean }) => Promise<void>;
  discoverAgents: () => Promise<{ targets: { id: string; label: string; availability: "available" | "unavailable" }[] }>;
  prepareRestore?: (path: string) => Promise<RestorePlan>;
  commitRestore?: (path: string, decisions: RestoreDecision[]) => Promise<RestoreResult>;
  pickDirectory?: () => Promise<string | null>;
}

function renderWizard(operations: Operations, runtime?: unknown) {
  return render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <OnboardingWizard
        initialBranch="select"
        libraryPath={defaultLibraryPath}
        operations={operations}
        runtime={runtime as never}
      />
    </I18nextProvider>,
  );
}

function createSkillHubI18nSync() {
  // Synchronous helper for tests; createSkillHubI18n is async, so reuse the loaded instance.
  const instance = (globalThis as { __skillhubI18n?: Awaited<ReturnType<typeof createSkillHubI18n>> }).__skillhubI18n;
  if (instance) return instance;
  throw new Error("i18n instance not initialized");
}

beforeAll(async () => {
  (globalThis as { __skillhubI18n?: Awaited<ReturnType<typeof createSkillHubI18n>> }).__skillhubI18n =
    await createSkillHubI18n(["zh-CN"]);
});

it("shows three initialization branches and routes to the create flow", async () => {
  const completeOnboarding = vi.fn(async () => undefined);
  renderWizard({ completeOnboarding, discoverAgents: async () => ({ targets: [] }) });

  expect(screen.getByRole("heading", { name: "选择初始化方式" })).toBeVisible();
  expect(screen.getByRole("button", { name: "新建集中库" })).toBeVisible();
  expect(screen.getByRole("button", { name: "使用已有集中库" })).toBeVisible();
  expect(screen.getByRole("button", { name: "从备份恢复" })).toBeVisible();

  await click(screen.getByRole("button", { name: "新建集中库" }));
  expect(screen.getByText(defaultLibraryPath)).toBeVisible();
});

it("restores from a backup through prepare and commit before finishing", async () => {
  const completeOnboarding = vi.fn(async () => undefined);
  const prepareRestore = vi.fn(async (): Promise<RestorePlan> => ({
    format_version: 1,
    skills: 1,
    deployments_requiring_rediscovery: 0,
    conflicts: [],
  }));
  const commitRestore = vi.fn(async (): Promise<RestoreResult> => ({
    skills_restored: 1,
    skills_skipped: 0,
    deployments_requiring_rediscovery: 0,
  }));
  const pickDirectory = vi.fn(async () => "C:/backup.skillhub");

  renderWizard(
    { completeOnboarding, discoverAgents: async () => ({ targets: [] }), prepareRestore, commitRestore, pickDirectory },
  );

  await click(screen.getByRole("button", { name: "从备份恢复" }));
  expect(screen.getByRole("heading", { name: "从备份恢复集中库" })).toBeVisible();

  await click(screen.getByRole("button", { name: "选择备份目录" }));
  expect(pickDirectory).toHaveBeenCalled();
  await waitFor(() => expect(screen.getByText("发现 1 个可恢复技能")).toBeVisible());

  await click(screen.getByRole("button", { name: "恢复并继续" }));
  expect(commitRestore).toHaveBeenCalledWith("C:/backup.skillhub", []);
  expect(completeOnboarding).toHaveBeenCalledWith({ libraryPath: defaultLibraryPath, skipped: false });
});

it("lets the user cancel the restore branch without committing or completing", async () => {
  const completeOnboarding = vi.fn(async () => undefined);
  const prepareRestore = vi.fn(async (): Promise<RestorePlan> => ({
    format_version: 1,
    skills: 0,
    deployments_requiring_rediscovery: 0,
    conflicts: [],
  }));
  const commitRestore = vi.fn(async (): Promise<RestoreResult> => ({
    skills_restored: 0,
    skills_skipped: 0,
    deployments_requiring_rediscovery: 0,
  }));
  const pickDirectory = vi.fn(async () => "C:/backup.skillhub");

  renderWizard(
    { completeOnboarding, discoverAgents: async () => ({ targets: [] }), prepareRestore, commitRestore, pickDirectory },
  );

  await click(screen.getByRole("button", { name: "从备份恢复" }));
  await click(screen.getByRole("button", { name: "选择备份目录" }));
  await waitFor(() => expect(screen.getByText("没有可恢复的技能")).toBeVisible());

  await click(screen.getByRole("button", { name: "返回" }));
  expect(commitRestore).not.toHaveBeenCalled();
  expect(completeOnboarding).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "选择初始化方式" })).toBeVisible();
});

it("routes the existing-library branch through a read-only compatibility scan", async () => {
  const completeOnboarding = vi.fn(async () => undefined);
  const runInitializationScan = vi.fn(async () => ({ kind: "completed" as const, result: emptyScanResult }));
  renderWizard(
    { completeOnboarding, discoverAgents: async () => ({ targets: [] }) },
    {
      getBootstrapView: async () => { throw new Error("not used"); },
      runInitializationScan,
    },
  );

  await click(screen.getByRole("button", { name: "使用已有集中库" }));
  expect(screen.getByRole("heading", { name: "确认集中库位置" })).toBeVisible();
  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByLabelText("我确认这里只识别 Agent，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "开始只读扫描" }));
  expect(runInitializationScan).toHaveBeenCalled();
});
