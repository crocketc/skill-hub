import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { BootstrapSnapshot, GovernanceTaskFact } from "../api/bindings";
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
import { queryClient } from "./queryClient";
import { relationshipsKeys } from "../features/relationships/api";

const relationshipOverviewQueryKey = ["relationship-overview", "all"] as const;

function taskFact(taskId: string, detail: string): GovernanceTaskFact {
  return {
    task_id: taskId,
    kind: "confirm_shared_directory_impact",
    subject_id: "safe-pdf",
    detail,
    resolved: false,
    created_at: "2026-09-15T00:00:00Z",
    resolved_at: null,
  };
}

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

function todoOnlyCommit(facade: ImportFacade): void {
  facade.commitImport = async (plan: ImportPlan, actions: Record<string, ImportAction>) =>
    plan.candidates.map<ImportResult>((candidate) => ({
      action: actions[candidate.id] ?? "copy",
      candidateId: candidate.id,
      message: "importWorkflow.commitMessages.imported",
      originalPreserved: true,
      status: "todo",
    }));
}

async function renderDiscoveryRoute(
  facade: ImportFacade,
  options: { locationState?: { initialSources?: string[]; onboardingImport?: boolean; governanceTaskId?: string } } = {},
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
              <Route element={<h1>关系治理工作台</h1>} path="relationships/governance" />
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
  await user.click(screen.getByRole("button", { name: "读取该来源的候选" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await user.click(await screen.findByRole("button", { name: "提交导入" }));
}

async function commitAllCandidateImport(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getAllByRole("button", { name: "导入 Skill" })[0]);
  await user.type(screen.getByLabelText("来源"), "C:/Skills");
  await user.click(screen.getByRole("button", { name: "读取该来源的候选" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("button", { name: "全选可导入候选" }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await user.click(await screen.findByRole("button", { name: "提交导入" }));
}

beforeEach(() => {
  queryClient.clear();
});

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

it("refreshes shared library and snapshot data when the only import result is todo", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  todoOnlyCommit(facade);
  queryClient.setQueryData(relationshipOverviewQueryKey, { pending_governance_tasks: [] });
  const { refreshSnapshot } = await renderDiscoveryRoute(facade);

  await commitSingleCandidateImport(user);

  expect(await screen.findByText("待处理 1")).toBeVisible();
  expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  expect(queryClient.getQueryState(relationshipOverviewQueryKey)?.isInvalidated).toBe(true);
});

it("invalidates the conflict workspace after an import writes conflict facts", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  queryClient.setQueryData(relationshipsKeys.conflicts({ relationshipRevision: "r1" }), {
    cases: [],
    handled_count: 0,
    handled: [],
    relationship_revision: "r1",
    last_verified_at: null,
  });
  const { refreshSnapshot } = await renderDiscoveryRoute(facade);

  await commitSingleCandidateImport(user);

  expect(await screen.findByText("所有选中的候选项都已完成处理。")).toBeVisible();
  expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  await waitFor(() => {
    expect(queryClient.getQueryState(relationshipsKeys.conflicts({ relationshipRevision: "r1" }))?.isInvalidated).toBe(true);
  });
});

it("refreshes shared data for a mixed succeeded and todo import result", async () => {
  const user = userEvent.setup();
  const facade = createMockImportFacade({ scenario: "safe-local" });
  facade.commitImport = async (plan, actions) => plan.candidates.map<ImportResult>((candidate, index) => ({
    action: actions[candidate.id] ?? "copy",
    candidateId: candidate.id,
    message: index === 0 ? "importWorkflow.commitMessages.imported" : "importWorkflow.commitMessages.skipped",
    originalPreserved: true,
    status: index === 0 ? "todo" : "succeeded",
  }));
  queryClient.setQueryData(relationshipOverviewQueryKey, { pending_governance_tasks: [] });
  const { refreshSnapshot } = await renderDiscoveryRoute(facade);

  await commitAllCandidateImport(user);

  expect(await screen.findByText("待处理 1")).toBeVisible();
  expect(screen.getByText("成功 1")).toBeVisible();
  expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  expect(queryClient.getQueryState(relationshipOverviewQueryKey)?.isInvalidated).toBe(true);
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

it("opens independent governance from the production import completion page", async () => {
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
  facade.commitImport = async () => [{
    action: "copy",
    candidateId: "safe-pdf",
    message: "importWorkflow.commitMessages.imported",
    originalPreserved: true,
    status: "succeeded",
  }];
  await renderDiscoveryRoute(facade);

  await user.click(screen.getAllByRole("button", { name: "导入 Skill" })[0]);
  await user.type(screen.getByLabelText("来源"), "C:/Skills");
  await user.click(screen.getByRole("button", { name: "读取该来源的候选" }));
  await user.click(await screen.findByRole("button", { name: "继续选择候选" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "分析冲突" }));
  await screen.findByRole("heading", { name: "处理需要确认的冲突" });
  await user.click(await screen.findByRole("button", { name: "提交导入" }));
  await user.click(await screen.findByRole("button", { name: "现在整理 Agent 副本" }));
  expect(await screen.findByRole("heading", { name: "关系治理工作台" })).toBeVisible();
  query.mockRestore();
});

it("refetches the latest governance task instead of using a fresh cached overview", async () => {
  const oldTask = taskFact("old-task", "旧关系概览");
  const freshTask = taskFact("fresh-task", "最新关系治理待办");
  queryClient.setQueryData(relationshipOverviewQueryKey, {
    agent_directory_capabilities: [],
    agent_execution_confirmed: false,
    conflict_cases: [],
    deployment_relations: [],
    pending_governance_tasks: [oldTask],
    source_relations: [],
  });
  const query = vi.spyOn(bindings, "queryApplication").mockResolvedValue({
    type: "relationship_overview",
    payload: {
      agent_directory_capabilities: [],
      agent_execution_confirmed: false,
      conflict_cases: [],
      deployment_relations: [],
      pending_governance_tasks: [freshTask],
      source_relations: [],
    },
  } as unknown as Awaited<ReturnType<typeof bindings.queryApplication>>);

  await renderDiscoveryRoute(createMockImportFacade({ scenario: "safe-local" }), {
    locationState: { governanceTaskId: freshTask.task_id },
  });

  expect(await screen.findByTestId("governance-task-fresh-task")).toHaveAttribute("aria-current", "true");
  expect(screen.queryByTestId("governance-task-old-task")).not.toBeInTheDocument();
  expect(query).toHaveBeenCalledTimes(1);
  query.mockRestore();
});
