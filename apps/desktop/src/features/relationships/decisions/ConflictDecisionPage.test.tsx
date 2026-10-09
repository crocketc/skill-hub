import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type {
  AnalyzeConflictScope,
  CommitUsageChange,
  ConflictAnalysis,
  ConflictResolutionOutcome,
  ConflictWorkspace,
  ConflictWorkspaceCase,
  EnvironmentProblemAnalysis,
  EnvironmentProblemView,
  SaveAsCopyReplacementPreview,
  PrepareUsageChange,
  PreparedUsageChange,
  ResolveConflictCase,
  UsageChangeResult,
} from "../../../api/bindings";
import { createSkillHubI18n } from "../../../i18n";
import {
  createOperationTracker,
  type OperationTracker,
} from "../../../platform/operationTracker";
import type { AppNotifications } from "../../../ui/notifications";
import type { UsageChangeFacade } from "../../removal/api";
import type { SaveAsCopyFacade } from "../../markdown/api";
import { ConflictDecisionPage } from "./ConflictDecisionPage";
import type { ConflictDecisionsFacade } from "./decisionsApi";
import type { RelationGovernanceFacade } from "../governance/api";

// --- 夹具：完全按任务 2 的 ConflictWorkspace DTO 形状构造 ---

const memberLib = {
  skill_id: null,
  version_id: null,
  provenance_id: null,
  directory_node_id: null,
  path: "/lib/notes",
  fingerprint: "sha256:aaa",
};
const memberAgent = {
  skill_id: null,
  version_id: null,
  provenance_id: null,
  directory_node_id: null,
  path: "/agent/notes",
  fingerprint: "sha256:bbb",
};

function makeCase(
  overrides: Partial<ConflictWorkspaceCase> & { conflictId: string; kind?: ConflictWorkspaceCase["case"]["kind"] },
): ConflictWorkspaceCase {
  const { conflictId, kind, ...rest } = overrides;
  return {
    case: {
      conflict_id: conflictId,
      kind,
      classification: "uncertain",
      member_skill_ids: [],
      members: [memberLib, memberAgent],
      evidence: {
        fingerprints_match: false,
        names_match: true,
        identity_direction: null,
        sufficient_identity_evidence: false,
      },
      user_decision: null,
      decided_at: null,
    },
    latest_analysis: null,
    analysis_stale: false,
    recommended_decision: null,
    ...rest,
  };
}

const analysisRecordA = {
  record_id: "rec:a",
  conflict_id: "conflict:a",
  scope: { type: "case", value: { conflict_id: "conflict:a" } } as AnalyzeConflictScope,
  input_fingerprint: "sha256:input-a",
  baseline_classification: "uncertain" as const,
  conclusion: {
    conflict_id: "conflict:a",
    baseline_classification: "uncertain" as const,
    summary: "成员指纹不同，倾向视为不同 Skill。",
    recommended_action: "distinct_skill" as const,
    recommended_keep_member: "/lib/notes",
    key_evidence: ["成员指纹不同", "目录用途不同"],
    uncertainties: ["版本字段缺失"],
    confidence: 72,
  },
  source: "llm" as const,
  analyzed_at: "2026-09-10T08:00:00Z",
  failure_code: null,
  adopted_by_user: false,
};

const caseA = makeCase({
  conflictId: "conflict:a",
  kind: "same_name_different_content",
  latest_analysis: analysisRecordA,
  recommended_decision: "keep_distinct",
});

const caseB = makeCase({
  conflictId: "conflict:b",
  kind: "duplicate_same_content",
});
caseB.case.evidence = {
  fingerprints_match: true,
  names_match: true,
  identity_direction: null,
  sufficient_identity_evidence: true,
};

const caseC = makeCase({
  conflictId: "conflict:c",
  kind: "same_name_different_content",
  latest_analysis: {
    ...analysisRecordA,
    record_id: "rec:c",
    conflict_id: "conflict:c",
    input_fingerprint: "sha256:old",
  },
  analysis_stale: true,
  recommended_decision: null,
});

function workspaceFixture(overrides: Partial<ConflictWorkspace> = {}): ConflictWorkspace {
  return {
    cases: [caseA, caseB, caseC],
    handled_count: 1,
    handled: [
      {
        conflict_id: "import-conflict:same_name_different_content:find-skills",
        decision: "keep_distinct",
        conclusion: "distinct_skill",
        decided_at: "1789832619",
      },
    ],
    relationship_revision: "r7",
    last_verified_at: null,
    ...overrides,
  };
}

const emptyRun: ConflictAnalysis = {
  scope: { type: "all" },
  input_fingerprint: "sha256:run",
  cases: [],
  skipped_decided_cases: 0,
  total_case_count: 0,
  source: "llm",
  failure_code: null,
};

function resolveOutcome(cmd: ResolveConflictCase): ConflictResolutionOutcome {
  return {
    conflict_id: cmd.conflict_id,
    decision: cmd.decision,
    decided_at: cmd.decision === "centralize_management" ? null : "2026-09-17T09:00:00Z",
    conclusion: cmd.decision === "keep_distinct" ? "distinct_skill" : cmd.decision === "confirm_same_skill" ? "same_skill_version" : null,
    governance: null,
    relationship_revision: "r8",
  };
}

function createFacade(workspace: ConflictWorkspace) {
  const facade: ConflictDecisionsFacade = {
    getConflictWorkspace: vi.fn(async () => workspace),
    isAiAvailable: vi.fn(async () => true),
    analyzeConflict: vi.fn(async (scope: AnalyzeConflictScope) => ({
      ...emptyRun,
      scope,
      total_case_count: workspace.cases.length,
    })),
    resolveConflictCase: vi.fn(async (cmd: ResolveConflictCase) => resolveOutcome(cmd)),
  };
  return facade;
}

function duplicateProblem(overrides: Partial<EnvironmentProblemView> = {}): EnvironmentProblemView {
  return {
    problem_id: "problem-duplicate",
    kind: "same_skill",
    entries: [
      { directory_id: "dir-a", directory_path: "/agents/codex/skills", directory_role: "agent_user", relative_entry_path: "formatter", runtime_name: "Formatter", content_fingerprint: "sha256:formatter", physical_identity: "physical:a", skill_id: null, relation_ids: [] },
      { directory_id: "dir-b", directory_path: "/agents/cursor/skills", directory_role: "agent_user", relative_entry_path: "formatter", runtime_name: "Formatter", content_fingerprint: "sha256:formatter", physical_identity: "physical:b", skill_id: null, relation_ids: [] },
    ],
    consumers: [{ agent_client_id: "codex", project_id: null }],
    environment_results: [],
    closed: false,
    ...overrides,
  };
}

function nameConflictProblem(): EnvironmentProblemView {
  return duplicateProblem({
    problem_id: "problem-name-conflict",
    kind: "name_conflict",
    entries: [
      {
        directory_id: "dir-agent",
        directory_path: "/agents/codex/skills",
        directory_role: "agent_user",
        relative_entry_path: "formatter",
        runtime_name: "Formatter",
        content_fingerprint: "sha256:source",
        physical_identity: "physical:source",
        skill_id: "skill-source",
        relation_ids: ["managed:deployment-source"],
      },
      {
        directory_id: "dir-project",
        directory_path: "/projects/demo/.agents/skills",
        directory_role: "project",
        relative_entry_path: "formatter",
        runtime_name: "Formatter",
        content_fingerprint: "sha256:other",
        physical_identity: "physical:other",
        skill_id: null,
        relation_ids: [],
      },
    ],
  });
}

function duplicateCleanupPrepared(problem: EnvironmentProblemView): PreparedUsageChange {
  return {
    operation_id: "op-duplicate-cleanup",
    prepared_id: "prepared-duplicate-cleanup",
    action: "resolve_duplicate",
    relationship_revision: "r8",
    affected_skill_ids: [],
    subject_versions: [],
    entry_evidence: [],
    consumers: [],
    impacts: [],
    limitations: [],
    duplicate_cleanup: {
      problem,
      retain_entry_key: { directory_id: "dir-a", relative_entry_path: "formatter" },
      selected_entry_keys: problem.entries.map(({ directory_id, relative_entry_path }) => ({ directory_id, relative_entry_path })),
      non_recognized_destination: null,
    },
  };
}

function derivedRenamePrepared(): PreparedUsageChange {
  return {
    operation_id: "op-derived-rename",
    prepared_id: "prepared-derived-rename",
    action: "derive_and_replace",
    relationship_revision: "r9",
    affected_skill_ids: ["skill-source"],
    subject_versions: [],
    entry_evidence: [],
    consumers: [],
    impacts: [],
    limitations: [],
    derived_rename: {
      source_skill_id: "skill-source",
      base_version_id: "version-current",
      runtime_name: "formatter-local",
      selected_relation_ids: ["managed:deployment-source"],
      targets: [
        {
          relation_id: "managed:deployment-source",
          deployment_id: "deployment-source",
          previous_path: "/agents/codex/skills/formatter",
          replacement_path: "/agents/codex/skills/formatter-local",
          requires_shared_target_confirmation: true,
          blocker: null,
        },
      ],
    },
  };
}

function derivedRenamePreview(): SaveAsCopyReplacementPreview {
  return {
    confirmation_fingerprint: "fingerprint-derived",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    preview_id: "replacement-preview-derived",
    source_skill_id: "skill-source",
    source_version_id: "version-current",
    targets: [
      {
        blocker: null,
        consumer_deployment_ids: ["deployment-source", "deployment-shared-consumer"],
        deployment_id: "deployment-source",
        managed: true,
        path: "/agents/codex/skills/formatter",
        requires_shared_target_confirmation: true,
        runtime_name: "formatter",
        target_id: "target-shared",
        version_id: "version-current",
      },
    ],
  };
}

function derivedRenameResult(): UsageChangeResult {
  return {
    operation_id: "op-derived-rename",
    prepared_id: "prepared-derived-rename",
    item_results: [
      {
        relation_ids: ["managed:deployment-source"],
        skill_id: "skill-derived",
        target: {
          kind: "agent",
          directory_id: "dir-agent",
          agent_client_id: "codex",
          directory_role: "agent_user",
          recognition: "supported",
        },
        action: "derive_and_replace",
        status: "failed",
        reason: "deployment.target_changed",
        recovery_point: null,
      },
    ],
    recovery_required: true,
    derived_skill_id: "skill-derived",
    recovery_operation_id: "recovery-derived",
  };
}

function createProblemFacade(analysis: EnvironmentProblemAnalysis): Pick<RelationGovernanceFacade, "getUsageEnvironmentProblems"> {
  return { getUsageEnvironmentProblems: vi.fn(async () => analysis) };
}

function makeNotifications(): AppNotifications & { notify: ReturnType<typeof vi.fn> } {
  return {
    notify: vi.fn(() => "notice-1"),
    dismiss: vi.fn(),
    markRead: vi.fn(),
    notices: [],
    unreadCount: 0,
    markAllRead: vi.fn(),
    clear: vi.fn(),
    dismissByKind: vi.fn(),
  };
}

// --- 渲染脚手架 ---

let lastLocation: { pathname: string; search: string } | null = null;

function LocationProbe() {
  const location = useLocation();
  lastLocation = { pathname: location.pathname, search: location.search };
  return null;
}

async function renderPage(
  facade: ConflictDecisionsFacade,
  options: {
    initialEntry?: string;
    tracker?: OperationTracker;
    problemFacade?: Pick<RelationGovernanceFacade, "getUsageEnvironmentProblems">;
    usageChangeFacade?: UsageChangeFacade;
    saveAsCopyFacade?: Pick<SaveAsCopyFacade, "saveAsCopyReplacementPreview">;
    getCurrentSkillVersion?: (skillId: string) => Promise<string | null>;
  } = {},
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tracker = options.tracker ?? createOperationTracker();
  const notifications = makeNotifications();
  lastLocation = null;
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[options.initialEntry ?? "/relationships/decisions"]}>
          <LocationProbe />
          <ConflictDecisionPage
          environmentFacade={options.problemFacade}
          facade={facade}
            getCurrentSkillVersion={options.getCurrentSkillVersion}
            saveAsCopyFacade={options.saveAsCopyFacade}
            notifications={notifications}
            tracker={tracker}
            usageChangeFacade={options.usageChangeFacade}
          />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { ...rendered, facade, notifications, tracker };
}

// --- 用例 ---

describe("ConflictDecisionPage", () => {
  it("offers derived rename for a name conflict with a managed usage", async () => {
    const problem = nameConflictProblem();
    const prepared = derivedRenamePrepared();
    const usageChangeFacade: UsageChangeFacade = {
      prepareUsageChange: vi.fn(async (_request: PrepareUsageChange) => prepared),
      commitUsageChange: vi.fn(async (_request: CommitUsageChange) => derivedRenameResult()),
    };
    const problemFacade = createProblemFacade({ problems: [problem], probe_limitations: [] });
    const saveAsCopyFacade: Pick<SaveAsCopyFacade, "saveAsCopyReplacementPreview"> = {
      saveAsCopyReplacementPreview: vi.fn(async () => derivedRenamePreview()),
    };
    await renderPage(createFacade(workspaceFixture({ cases: [], handled: [], handled_count: 0 })), {
      initialEntry: "/relationships/decisions?problemId=problem-name-conflict",
      problemFacade,
      saveAsCopyFacade,
      usageChangeFacade,
      getCurrentSkillVersion: vi.fn(async () => "version-current"),
    });

    fireEvent.click(await screen.findByRole("button", { name: "为选中位置另存为独立技能" }));
    const dialog = await screen.findByRole("dialog", { name: "为选中位置另存" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "新技能运行名" }), {
      target: { value: "formatter-local" },
    });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "/agents/codex/skills/formatter" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "预览替换目标" }));

    expect(await within(dialog).findByRole("checkbox", { name: /共享入口/ })).toBeVisible();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /共享入口/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "准备准确方案" }));
    await waitFor(() => expect(usageChangeFacade.prepareUsageChange).toHaveBeenCalledWith(expect.objectContaining({
      action: "derive_and_replace",
      problem_id: "problem-name-conflict",
      skill_id: "skill-source",
      base_version_id: "version-current",
      runtime_name: "formatter-local",
      selected_relation_ids: ["managed:deployment-source"],
      confirmed_shared_relation_ids: ["managed:deployment-source"],
    })));
    expect(await within(dialog).findByText("/agents/codex/skills/formatter-local")).toBeVisible();
    const readsBeforeCommit = (problemFacade.getUsageEnvironmentProblems as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "我已核对新技能和替换位置，确认继续。" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认创建并替换" }));

    await waitFor(() => expect(usageChangeFacade.commitUsageChange).toHaveBeenCalledWith({
      operation_id: "op-derived-rename",
      prepared_id: "prepared-derived-rename",
    }));
    expect(await within(dialog).findByText("新技能已创建，但部分使用位置需要处理。"))
      .toBeVisible();
    expect(within(dialog).getByRole("link", { name: "前往恢复中心" }))
      .toHaveAttribute("href", "/recovery?operationId=recovery-derived");
    expect((problemFacade.getUsageEnvironmentProblems as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThan(readsBeforeCommit);
    fireEvent.click(within(dialog).getByRole("button", { name: "查看新技能" }));
    expect(lastLocation).toEqual({ pathname: "/library/skill-derived", search: "" });
  });

  it("does not offer derived rename when a name conflict has no managed source", async () => {
    const problem = nameConflictProblem();
    problem.entries = problem.entries.map((entry) => ({
      ...entry,
      skill_id: null,
      relation_ids: [],
    }));
    await renderPage(createFacade(workspaceFixture({ cases: [], handled: [], handled_count: 0 })), {
      initialEntry: "/relationships/decisions?problemId=problem-name-conflict",
      problemFacade: createProblemFacade({ problems: [problem], probe_limitations: [] }),
    });

    expect(await screen.findByRole("heading", { name: "多个目录中存在重名技能" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "为选中位置另存为独立技能" }))
      .not.toBeInTheDocument();
  });

  it("handles a current same-skill environment problem in the shared conflict workflow", async () => {
    const problem = duplicateProblem();
    const prepared = duplicateCleanupPrepared(problem);
    const problemFacade: Pick<RelationGovernanceFacade, "getUsageEnvironmentProblems"> = {
      getUsageEnvironmentProblems: vi.fn()
        .mockResolvedValueOnce({ problems: [problem], probe_limitations: [] })
        .mockResolvedValue({ problems: [{ ...problem, closed: true }], probe_limitations: [] }),
    };
    const usageChangeFacade: UsageChangeFacade = {
      prepareUsageChange: vi.fn(async (_request: PrepareUsageChange) => prepared),
      commitUsageChange: vi.fn(async (_request: CommitUsageChange): Promise<UsageChangeResult> => ({
        operation_id: prepared.operation_id,
        prepared_id: prepared.prepared_id,
        item_results: [],
        recovery_required: false,
      })),
    };
    await renderPage(createFacade(workspaceFixture({ cases: [], handled: [], handled_count: 0 })), {
      initialEntry: "/relationships/decisions?problemId=problem-duplicate&returnTo=%2Frelationships%2Fgovernance%3Fagent_id%3Dcodex%26problem_id%3Dproblem-duplicate",
      problemFacade,
      usageChangeFacade,
    });

    expect(await screen.findByRole("heading", { name: "同一技能出现在多个目录" })).toBeVisible();
    expect(screen.getByText("/agents/codex/skills/formatter")).toBeVisible();
    expect(screen.getByText("/agents/cursor/skills/formatter")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "整理同一技能" }));
    const dialog = await screen.findByRole("dialog", { name: "处理多目录中的同一技能" });
    fireEvent.click(within(dialog).getByRole("button", { name: "预览清理影响" }));
    await waitFor(() => expect(usageChangeFacade.prepareUsageChange).toHaveBeenCalledWith(expect.objectContaining({
      action: "resolve_duplicate",
      problem_id: "problem-duplicate",
      selected_entry_keys: [
        { directory_id: "dir-a", relative_entry_path: "formatter" },
        { directory_id: "dir-b", relative_entry_path: "formatter" },
      ],
    })));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "我已核对保留项和清理范围，了解其余项将先备份再移除。" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理" }));
    await waitFor(() => expect(usageChangeFacade.commitUsageChange).toHaveBeenCalledWith({
      operation_id: prepared.operation_id,
      prepared_id: prepared.prepared_id,
    }));
    expect(await within(dialog).findByRole("status")).toHaveTextContent("操作已完成，相关目录已重新扫描。");
    expect(problemFacade.getUsageEnvironmentProblems).toHaveBeenCalledTimes(2);
  });

  it("keeps a stale or same-name environment issue out of duplicate cleanup actions", async () => {
    const problemFacade = createProblemFacade({
      problems: [duplicateProblem({ problem_id: "problem-name", kind: "name_conflict" })],
      probe_limitations: [],
    });
    await renderPage(createFacade(workspaceFixture({ cases: [], handled: [], handled_count: 0 })), {
      initialEntry: "/relationships/decisions?problemId=problem-missing",
      problemFacade,
    });
    expect(await screen.findByText(/此问题已解决或发生变化。旧链接不能继续操作/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "清理重复副本" })).not.toBeInTheDocument();
  });

  it("shows a current same-name environment issue without offering duplicate cleanup", async () => {
    const problem = duplicateProblem({ problem_id: "problem-name", kind: "name_conflict" });
    await renderPage(createFacade(workspaceFixture({ cases: [], handled: [], handled_count: 0 })), {
      initialEntry: "/relationships/decisions?problemId=problem-name",
      problemFacade: createProblemFacade({ problems: [problem], probe_limitations: [] }),
    });

    expect(await screen.findByRole("heading", { name: "多个目录中存在重名技能" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "整理同一技能" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("多个使用位置出现同名但内容不同的 Skill，需要分别确认。");
  });

  it("does not offer duplicate cleanup for a same-skill issue with fewer than two entries", async () => {
    const problem = duplicateProblem({ entries: duplicateProblem().entries.slice(0, 1) });
    await renderPage(createFacade(workspaceFixture({ cases: [], handled: [], handled_count: 0 })), {
      initialEntry: "/relationships/decisions?problemId=problem-duplicate",
      problemFacade: createProblemFacade({ problems: [problem], probe_limitations: [] }),
    });

    expect(await screen.findByRole("heading", { name: "同一技能出现在多个目录" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "整理同一技能" })).not.toBeInTheDocument();
  });

  it("renders only the pending uncertain queue and keeps handled items in history", async () => {
    const { facade } = await renderPage(createFacade(workspaceFixture()));

    expect(await screen.findByText("待确认 3 组")).toBeVisible();
    expect(screen.getByText("累计已处理 1 组")).toBeVisible();
    // 队列即 DTO 投影：三组全部可见。
    expect(screen.getByRole("button", { name: "conflict:a" })).toBeVisible();
    expect(screen.getByRole("button", { name: "conflict:b" })).toBeVisible();
    expect(screen.getByRole("button", { name: "conflict:c" })).toBeVisible();
    // 默认聚焦第一组：双侧对比展示两个成员路径。
    expect(screen.getByText("冲突组 conflict:a")).toBeVisible();
    expect(screen.getByText("/lib/notes")).toBeVisible();
    expect(screen.getByText("/agent/notes")).toBeVisible();
    // 确定性证据事实直接可读。
    expect(screen.getByText("指纹不一致")).toBeVisible();
    expect(screen.getByText("名称一致")).toBeVisible();
    // 已处理项只进历史，绝不回流队列（DTO 中没有它，也不得从 handled 混入）。
    expect(screen.getByRole("heading", { name: "已处理记录" })).toBeVisible();
    // DEV-15：历史行以可读信息为主——名称尾段 + 本地化时间；
    // 裸冲突 id 与 unix 秒时间戳不进界面。
    expect(screen.getByText("find-skills")).toBeVisible();
    expect(screen.getByText(/处理于 2026/)).toBeVisible();
    expect(screen.queryByText(/import-conflict:/)).not.toBeInTheDocument();
    expect(screen.queryByText("处理于 1789832619")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "conflict:z" })).not.toBeInTheDocument();
    // 没有「刷新冲突」按钮：队列只随关系刷新/重新扫描变化。
    expect(screen.queryByRole("button", { name: "刷新冲突" })).not.toBeInTheDocument();
    expect(facade.getConflictWorkspace).toHaveBeenCalledTimes(1);
  });

  it("filters the queue with category chips and navigates with prev/next", async () => {
    await renderPage(createFacade(workspaceFixture()));
    await screen.findByText("冲突组 conflict:a");

    fireEvent.click(screen.getByRole("button", { name: "重名" }));
    expect(screen.queryByRole("button", { name: "conflict:b" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "conflict:a" })).toBeVisible();
    expect(screen.getByRole("button", { name: "conflict:c" })).toBeVisible();
    expect(screen.getByText("第 1 / 2 组")).toBeVisible();
    expect(lastLocation?.search).toContain("category=same_name_different_content");

    const prev = screen.getByRole("button", { name: "上一个" });
    expect(prev).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一个" }));
    expect(screen.getByText("冲突组 conflict:c")).toBeVisible();
    expect(screen.getByText("第 2 / 2 组")).toBeVisible();
    expect(screen.getByRole("button", { name: "下一个" })).toBeDisabled();
    expect(new URLSearchParams(lastLocation?.search).get("conflictId")).toBe("conflict:c");

    fireEvent.click(screen.getByRole("button", { name: "上一个" }));
    expect(screen.getByText("冲突组 conflict:a")).toBeVisible();
  });

  it("honors a deep link carrying category and conflict id", async () => {
    await renderPage(createFacade(workspaceFixture()), {
      initialEntry: "/relationships/decisions?category=duplicate_same_content&conflictId=conflict:b",
    });

    expect(await screen.findByText("冲突组 conflict:b")).toBeVisible();
    expect(screen.getByText("第 1 / 1 组")).toBeVisible();
    expect(screen.queryByRole("button", { name: "conflict:a" })).not.toBeInTheDocument();
  });

  it("ignores a legacy third-category query and keeps the current issue queue visible", async () => {
    await renderPage(createFacade(workspaceFixture()), {
      initialEntry: "/relationships/decisions?category=same_source_fork&conflictId=conflict:a",
    });

    expect(await screen.findByText("冲突组 conflict:a")).toBeVisible();
    expect(screen.getByRole("button", { name: "conflict:b" })).toBeVisible();
    expect(screen.getAllByRole("group", { name: "冲突类别" })[0]).toBeVisible();
    expect(screen.queryByRole("button", { name: "同源分叉" })).not.toBeInTheDocument();
  });

  it("keeps manual decisions available when no LLM provider is configured", async () => {
    const facade = createFacade(workspaceFixture());
    facade.isAiAvailable = vi.fn(async () => false);
    const { notifications } = await renderPage(facade);

    expect(await screen.findByText("尚未配置可用的 LLM 供应商；人工决定不受影响。")).toBeVisible();
    const keepDistinct = screen.getByRole("button", { name: "保留为独立 Skill" });
    expect(keepDistinct).toBeEnabled();

    fireEvent.click(keepDistinct);
    await waitFor(() => {
      expect(facade.resolveConflictCase).toHaveBeenCalledTimes(1);
    });
    expect(facade.resolveConflictCase).toHaveBeenCalledWith({
      conflict_id: "conflict:a",
      decision: "keep_distinct",
      expected_relationship_revision: "r7",
    });
    // 统一执行桥：结果反馈经通知中心；工作台随即失效重取。
    expect(notifications.notify).toHaveBeenCalled();
    await waitFor(() => {
      expect(facade.getConflictWorkspace).toHaveBeenCalledTimes(2);
    });
    // 决定完成后焦点推进到下一组，URL 同步。
    await waitFor(() => {
      expect(new URLSearchParams(lastLocation?.search).get("conflictId")).toBe("conflict:b");
    });
  });

  it("runs the three AI scopes with exact payloads through the unified tracker", async () => {
    const facade = createFacade(workspaceFixture());
    facade.analyzeConflict = vi.fn(async (scope: AnalyzeConflictScope) => ({
      ...emptyRun,
      scope,
      cases: [],
      skipped_decided_cases: 1,
      total_case_count: 5,
    }));
    const { tracker } = await renderPage(facade);
    await screen.findByText("冲突组 conflict:a");

    fireEvent.click(screen.getByRole("button", { name: "分析此冲突" }));
    await waitFor(() => {
      expect(facade.analyzeConflict).toHaveBeenCalledWith({
        type: "case",
        value: { conflict_id: "conflict:a" },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "分析当前类别" }));
    await waitFor(() => {
      expect(facade.analyzeConflict).toHaveBeenCalledWith({
        type: "category",
        value: { classification: "uncertain" },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "分析全部待确认" }));
    await waitFor(() => {
      expect(facade.analyzeConflict).toHaveBeenCalledWith({ type: "all" });
    });

    // 三个范围各走一次统一执行桥，全部成功落终态。
    await waitFor(() => {
      expect(tracker.getSnapshot()).toHaveLength(3);
    });
    for (const operation of tracker.getSnapshot()) {
      expect(operation.kind).toBe("ai_analysis");
      expect(operation.status).toBe("success");
    }
    // 覆盖范围如实标注：单次请求上限造成的部分覆盖不冒充全量。
    expect(await screen.findByText("本次已分析 0 组（范围内共 5 组）")).toBeVisible();
    expect(screen.getByText("已有用户裁决的冲突组：1 个（不送 AI）。")).toBeVisible();
    // 每次分析完成后工作台失效重取，结论回流 latest_analysis。
    await waitFor(() => {
      expect(facade.getConflictWorkspace).toHaveBeenCalledTimes(4);
    });
  });

  // 任务 7 review minor（任务 10 sweep）：决定写入失败必须给出 danger 通知、
  // 不产生 unhandled rejection（void resolve 的 .catch 一致性），且即时写入
  // 不占用在途顶栏（tracker 保持空）。
  it("surfaces a failed decision as a danger notice without an unhandled rejection", async () => {
    const facade = createFacade(workspaceFixture());
    facade.resolveConflictCase = vi.fn(async () => {
      throw new Error("conflict.revision_conflict");
    });
    const { notifications, tracker } = await renderPage(facade);
    await screen.findByText("冲突组 conflict:a");

    fireEvent.click(screen.getByRole("button", { name: "保留为独立 Skill" }));

    await waitFor(() => {
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "danger", title: "未能写入冲突结论" }),
      );
    });
    // 即时写入命令（单次同步响应）不进在途投影、不让顶栏闪烁。
    expect(tracker.getSnapshot()).toHaveLength(0);
    // 写入失败时该组留在队列：焦点不推进、不产生伪成功。
    await waitFor(() => {
      expect(screen.getByText("冲突组 conflict:a")).toBeVisible();
    });
    expect(new URLSearchParams(lastLocation?.search).get("conflictId")).not.toBe("conflict:b");
  });

  it("keeps an AI analysis failure inline with a failed tracker record and no global notice", async () => {
    const facade = createFacade(workspaceFixture());
    facade.analyzeConflict = vi.fn(async () => {
      throw new Error("llm.unavailable");
    });
    const { notifications, tracker } = await renderPage(facade);
    await screen.findByText("冲突组 conflict:a");

    fireEvent.click(screen.getByRole("button", { name: "分析此冲突" }));

    // AI 分析走 phased 桥：失败落 failed 终态；工作台内联展示失败原因。
    await waitFor(() => {
      expect(tracker.getSnapshot()).toEqual([
        expect.objectContaining({ kind: "ai_analysis", status: "failed" }),
      ]);
    });
    expect(await screen.findByText(/AI 返回未知失败/)).toBeVisible();
    // 文档化的 inline-only 决策：AI 分析结果不额外发全局通知。
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("executes the concrete human decision via 按建议 instead of an adopted-only write", async () => {
    const facade = createFacade(workspaceFixture());
    const { notifications } = await renderPage(facade);
    await screen.findByText("冲突组 conflict:a");

    const follow = screen.getByRole("button", { name: "按建议：保留为独立 Skill" });
    fireEvent.click(follow);

    await waitFor(() => {
      expect(facade.resolveConflictCase).toHaveBeenCalledWith({
        conflict_id: "conflict:a",
        decision: "keep_distinct",
        expected_relationship_revision: "r7",
      });
    });
    expect(notifications.notify).toHaveBeenCalled();
  });

  it("links file-related decisions to the governance preview without submitting anything", async () => {
    const facade = createFacade(workspaceFixture());
    const { tracker } = await renderPage(facade);
    await screen.findByText("冲突组 conflict:a");

    fireEvent.click(screen.getByRole("button", { name: "转入技能库管理" }));

    // 不跨页自动提交：不写决定、不进执行桥，只携带冲突上下文跳治理预览。
    expect(facade.resolveConflictCase).not.toHaveBeenCalled();
    expect(tracker.getSnapshot()).toHaveLength(0);
    await waitFor(() => {
      expect(lastLocation?.pathname).toBe("/relationships/governance");
    });
    const params = new URLSearchParams(lastLocation?.search ?? "");
    expect(params.get("from")).toBe("conflict");
    expect(params.get("conflictId")).toBe("conflict:a");
  });

  it("marks stale analysis as expired and offers no executable suggestion", async () => {
    await renderPage(createFacade(workspaceFixture()), {
      initialEntry: "/relationships/decisions?conflictId=conflict:c",
    });

    expect(await screen.findByText("冲突组 conflict:c")).toBeVisible();
    // 徽标同时出现在结论区与队列行：存在即视为已标注。
    expect((await screen.findAllByText("分析已过期")).length).toBeGreaterThan(0);
    expect(
      screen.getByText("冲突事实已变化：旧结论不再对应当前状态，不能作为执行依据。"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /按建议/ })).not.toBeInTheDocument();
    // 可执行建议来自 DTO 的 recommended_decision：过期时必为空。
    expect(screen.queryByText(/建议动作/)).not.toBeInTheDocument();
  });

  it("shows evidence, uncertainties and the executable plan of a fresh AI conclusion", async () => {
    await renderPage(createFacade(workspaceFixture()));
    await screen.findByText("冲突组 conflict:a");

    // 证据、不确定点、可执行方案完整可见。
    expect(screen.getByText("关键证据")).toBeVisible();
    expect(screen.getByText("成员指纹不同")).toBeVisible();
    expect(screen.getByText("目录用途不同")).toBeVisible();
    expect(screen.getByText("不确定点")).toBeVisible();
    expect(screen.getByText("版本字段缺失")).toBeVisible();
    expect(screen.getByText("建议动作：保留为独立 Skill")).toBeVisible();
    expect(screen.getByText("建议保留：/lib/notes")).toBeVisible();
    expect(screen.getByText("置信度：72%")).toBeVisible();
    // 建议只是建议：确定性基线先于 AI 结论展示。
    const section = screen.getByTestId("conflict-ai-conclusion");
    const text = section.textContent ?? "";
    expect(text.indexOf("确定性基线")).toBeLessThan(
      text.indexOf("成员指纹不同，倾向视为不同 Skill。"),
    );
  });

  it("advances focus with 暂不处理 without writing any decision", async () => {
    const facade = createFacade(workspaceFixture());
    await renderPage(facade);
    await screen.findByText("冲突组 conflict:a");

    fireEvent.click(screen.getByRole("button", { name: "暂不处理" }));

    // 「暂不处理」不是决定：不写结论、不写伪历史。
    expect(facade.resolveConflictCase).not.toHaveBeenCalled();
    expect(screen.getByText("冲突组 conflict:b")).toBeVisible();
    expect(new URLSearchParams(lastLocation?.search).get("conflictId")).toBe("conflict:b");
  });

  it("selects a queue row on click and reflects it in the URL", async () => {
    await renderPage(createFacade(workspaceFixture()));
    await screen.findByText("冲突组 conflict:a");

    fireEvent.click(screen.getByRole("button", { name: "conflict:b" }));
    expect(screen.getByText("冲突组 conflict:b")).toBeVisible();
    expect(new URLSearchParams(lastLocation?.search).get("conflictId")).toBe("conflict:b");
  });

  it("celebrates handled conflicts when the queue drains, and stays neutral at zero", async () => {
    const { unmount } = await renderPage(
      createFacade(
        workspaceFixture({
          cases: [],
          handled_count: 3,
          handled: [
            { conflict_id: "conflict:x", decision: "keep_distinct", conclusion: "distinct_skill", decided_at: "2026-09-01T10:00:00Z" },
            { conflict_id: "conflict:y", decision: "confirm_same_skill", conclusion: "same_skill_version", decided_at: "2026-09-02T10:00:00Z" },
            { conflict_id: "conflict:z", decision: "keep_distinct", conclusion: "distinct_skill", decided_at: "2026-09-03T10:00:00Z" },
          ],
        }),
      ),
    );

    expect(await screen.findByText("干得漂亮！累计已处理 3 组冲突。")).toBeVisible();
    expect(screen.getByText("新冲突会在关系刷新或重新扫描后出现在这里。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "刷新冲突" })).not.toBeInTheDocument();
    unmount();

    await renderPage(
      createFacade(workspaceFixture({ cases: [], handled_count: 0, handled: [] })),
    );
    expect(await screen.findByText("当前没有待确认的冲突。")).toBeVisible();
    expect(screen.queryByText(/干得漂亮/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新冲突" })).not.toBeInTheDocument();
  });

  it("shows deterministic identical-content imports in history without adding a decision card", async () => {
    const deterministic = makeCase({
      conflictId: "import-conflict:duplicate_same_content:notes",
      kind: "duplicate_same_content",
    });
    deterministic.case.classification = "same_skill_version";
    deterministic.case.evidence = {
      fingerprints_match: true,
      names_match: true,
      identity_direction: "same_skill",
      sufficient_identity_evidence: true,
    };
    await renderPage(
      createFacade(workspaceFixture({
        cases: [],
        handled_count: 0,
        handled: [],
        deterministic_history: [deterministic],
      })),
    );

    expect(await screen.findByText("内容一致的导入")).toBeVisible();
    expect(screen.getByText("已记录为同一 Skill 版本，无需重复裁决。")).toBeVisible();
    expect(screen.queryByRole("button", { name: /duplicate_same_content/ })).not.toBeInTheDocument();
  });

  it("shows honest loading and failure states for the workspace query", async () => {
    const i18n = await createSkillHubI18n(["zh-CN"]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const pendingFacade: ConflictDecisionsFacade = {
      getConflictWorkspace: () => new Promise(() => {}),
      isAiAvailable: async () => true,
      analyzeConflict: async (scope) => ({ ...emptyRun, scope }),
      resolveConflictCase: async (cmd) => resolveOutcome(cmd),
    };
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/relationships/decisions"]}>
            <ConflictDecisionPage facade={pendingFacade} tracker={createOperationTracker()} />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    expect(screen.getByText("正在读取冲突工作台…")).toBeVisible();

    const failingFacade: ConflictDecisionsFacade = {
      ...pendingFacade,
      getConflictWorkspace: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={["/relationships/decisions"]}>
            <ConflictDecisionPage facade={failingFacade} tracker={createOperationTracker()} />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("冲突工作台暂时无法读取。");
  });
});
