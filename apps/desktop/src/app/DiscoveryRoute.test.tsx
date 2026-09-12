import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { BootstrapSnapshot } from "../api/bindings";
import { createSkillHubI18n } from "../i18n";
import { AppNotificationsProvider } from "../ui/notifications";
import type { DiscoveryFacade } from "../features/discovery/api";
import {
  createMockImportFacade,
  type ImportAction,
  type ImportFacade,
  type ImportPlan,
  type ImportResult,
} from "../features/import/api";
import { DiscoveryRoute } from "./DiscoveryRoute";
import type { BootstrapOutletContext } from "./AppShell";

const snapshot: BootstrapSnapshot = {
  agent_count: 3,
  discovered_agent_count: 3,
  deployed_count: 9,
  deployment_categories: [],
  tag_categories: [],
  initialization_state: "initialized" as const,
  last_scan_at: null,
  library_path: "C:\\Users\\Test\\SkillHub",
  onboarding_skipped: false,
  pending: { by_kind: {}, total: 0 },
  project_count: 5,
  recent_operations: [],
  recovery_state: "clean" as const,
  skill_count: 42,
};

function stubDiscoveryFacade(): DiscoveryFacade {
  return {
    getDiscoverySnapshot: async () => {
      throw new Error("not used");
    },
    scanTargets: async () => {
      throw new Error("not used");
    },
    searchOnlineSources: async () => {
      throw new Error("not used");
    },
    listSkillRepos: async () => [],
    discoverRepoSkills: async () => ({ skills: [], warnings: [] }),
    discoverAgentsLockSkills: async () => [],
    addSkillRepo: async () => [],
    removeSkillRepo: async () => [],
    downloadRepoSkill: async () => {
      throw new Error("not used");
    },
    openExternalUrl: async () => {},
    createIgnoreRule: async () => {},
  };
}

function allFailedCommit(facade: ImportFacade): void {
  facade.commitImport = async (plan: ImportPlan, actions: Record<string, ImportAction>) =>
    plan.candidates.map<ImportResult>((candidate) => ({
      action: actions[candidate.id] ?? "copy",
      candidateId: candidate.id,
      message: "目标目录不可写",
      status: "failed",
    }));
}

async function renderDiscoveryRoute(
  facade: ImportFacade,
  options: { locationState?: { initialSources?: string[]; onboardingImport?: boolean } } = {},
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const refreshSnapshot = vi.fn(async () => {});
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[{ pathname: "/discovery/local", state: options.locationState }]}>
        <AppNotificationsProvider>
          <Routes>
            <Route
              element={<Outlet context={{ refreshSnapshot, snapshot } satisfies BootstrapOutletContext} />}
              path="/"
            >
              <Route
                element={<DiscoveryRoute discoveryFacade={stubDiscoveryFacade()} importFacade={facade} view="local" />}
                path="discovery/local"
              />
            </Route>
          </Routes>
        </AppNotificationsProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
  return { refreshSnapshot };
}

async function commitSingleCandidateImport(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getAllByRole("button", { name: "导入 Skill" })[0]);
  await user.type(screen.getByLabelText("来源"), "C:/Skills");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await user.click(await screen.findByRole("button", { name: "提交导入" }));
}

it("refreshes the shared bootstrap snapshot after an import with a succeeded result", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const { refreshSnapshot } = await renderDiscoveryRoute(facade);

  await commitSingleCandidateImport(user);

  expect(await screen.findByText("所有选中的候选项都已完成处理。")).toBeVisible();
  expect(screen.getByText("成功 1")).toBeVisible();
  expect(refreshSnapshot).toHaveBeenCalledTimes(1);
});

it("does not refresh the bootstrap snapshot when every import result failed", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  allFailedCommit(facade);
  const { refreshSnapshot } = await renderDiscoveryRoute(facade);

  await commitSingleCandidateImport(user);

  expect(await screen.findByText("失败 1")).toBeVisible();
  expect(refreshSnapshot).not.toHaveBeenCalled();
});

it("renders the onboarding handoff import without the manual add-source action", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  await renderDiscoveryRoute(facade, {
    locationState: {
      initialSources: ["C:/codex/skills", "C:/claude/skills"],
      onboardingImport: true,
    },
  });

  // 初始化交接打开向导：已选扫描来源默认选中，无“添加到已选来源”。
  expect(screen.getByRole("checkbox", { name: "C:/codex/skills" })).toBeChecked();
  await user.type(screen.getByLabelText("来源"), "C:/manual/skills");
  expect(screen.queryByRole("button", { name: "添加到已选来源" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "读取已选目录候选" }));
  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeVisible();
  expect(facade.calls.acquiredSources).toEqual(["C:/codex/skills", "C:/claude/skills"]);
});
