import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { BootstrapSnapshot } from "../api/bindings";
import * as bindings from "../api/bindings";
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
  const facade = createMockImportFacade({ scenario: "safe-local" });
  await renderDiscoveryRoute(facade, {
    locationState: {
      initialSources: ["C:/codex/skills", "C:/claude/skills"],
      onboardingImport: true,
    },
  });

  // 初始化交接打开向导：已选扫描来源默认选中，无“添加到已选来源”。
  expect(screen.getByRole("checkbox", { name: "C:/codex/skills" })).toBeChecked();
  expect(screen.queryByRole("button", { name: "添加到已选来源" })).not.toBeInTheDocument();

  expect(await screen.findByRole("button", { name: "继续选择候选" })).toBeVisible();
  expect(facade.calls.acquiredSources).toEqual(["C:/codex/skills", "C:/claude/skills"]);
});

it("opens governance work from the production discovery route through the relationship overview query", async () => {
  const user = userEvent.setup();
  const task = {
    task_id: "governance-task-1",
    kind: "confirm_shared_directory_impact" as const,
    subject_id: "safe-pdf",
    detail: "该目录由 Agent 共用；导入不会删除原件。",
    resolved: false,
    created_at: "2026-09-15T00:00:00Z",
    resolved_at: null,
  };
  const query = vi.spyOn(bindings, "queryApplication").mockResolvedValue({
    type: "relationship_overview",
    payload: {
      agent_directory_capabilities: [],
      agent_execution_confirmed: false,
      conflict_cases: [],
      deployment_relations: [],
      pending_governance_tasks: [task],
      source_relations: [],
    },
  } as unknown as Awaited<ReturnType<typeof bindings.queryApplication>>);
  const facade = createMockImportFacade({ scenario: "safe-local" });
  const originalAnalyze = facade.analyzeConflicts.bind(facade);
  facade.analyzeConflicts = async (candidates, onProgress) => ({
    ...(await originalAnalyze(candidates, onProgress)),
    governanceGroups: [{
      group_id: "agent-managed-source",
      classification: "agent_managed_source",
      impact_summary: "该目录由 Agent 共用；导入不会删除原件。",
      default_action: "preserve_original",
      available_actions: ["preserve_original", "create_todo"],
      members: [{ member_id: "safe-pdf", display_name: "PDF" }],
    }],
  });
  facade.commitImport = async () => [{
    action: "copy",
    candidateId: "safe-pdf",
    message: "importWorkflow.commitMessages.imported",
    originalPreserved: true,
    governanceTasks: [task],
    status: "todo",
  }];
  await renderDiscoveryRoute(facade);

  await user.click(screen.getAllByRole("button", { name: "导入 Skill" })[0]);
  await user.type(screen.getByLabelText("来源"), "C:/Skills");
  await user.click(screen.getByRole("button", { name: "解析来源" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await screen.findByRole("heading", { name: "确认导入后的关系处理" });
  await user.click(screen.getByRole("radio", { name: "创建待办" }));
  await user.click(screen.getByRole("button", { name: "确认关系处理" }));
  await user.click(await screen.findByRole("button", { name: "提交导入" }));
  await user.click(screen.getByRole("button", { name: /查看治理待办/ }));

  await waitFor(() => expect(query).toHaveBeenCalledWith({
    type: "get_relationship_overview",
    payload: { scope: { type: "all" } },
  }));
  expect(await screen.findByRole("heading", { name: "关系治理待办" })).toBeVisible();
  expect(screen.getByTestId("governance-task-governance-task-1")).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(screen.getByText(task.detail)).toBeVisible();
  query.mockRestore();
});
