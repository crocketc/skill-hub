import type {
  BootstrapSnapshot,
  ConflictWorkspace,
  RelationGovernanceLedger,
  SkillRelationshipCandidate,
} from "../../api/bindings";
import { AppShell } from "../../app/AppShell";
import type { RelationshipsFacade } from "../relationships/api";

/**
 * Deterministic DEV-only fixture for /__preview/overview. It exercises the
 * full overview information surface (chart, rail details, pending summary)
 * without touching the disk, network, or providers, and includes one long
 * project label so layout overflow stays checkable at every width.
 */
const OVERVIEW_PREVIEW_SNAPSHOT: BootstrapSnapshot = {
  initialization_state: "initialized",
  library_path: "/Users/preview/SkillHub",
  onboarding_skipped: false,
  agent_count: 3,
  discovered_agent_count: 5,
  deployed_count: 27,
  deployment_categories: [
    { count: 12, dimension: "agent", key: "openai.codex-cli", label_code: "Codex" },
    { count: 8, dimension: "agent", key: "anthropic.claude-code", label_code: "Claude Code" },
    { count: 4, dimension: "agent", key: "windsurf.windsurf", label_code: "Windsurf" },
    { count: 3, dimension: "agent", key: "zcode.zcode", label_code: "ZCode" },
    {
      count: 9,
      dimension: "project",
      key: "aurora-platform",
      label_code: "Aurora Mobile Workspace",
    },
    { count: 6, dimension: "project", key: "orbital-docs", label_code: "Orbital Docs" },
    { count: 3, dimension: "project", key: "website", label_code: "SkillHub Website" },
  ],
  tag_categories: [
    { key: "writing", count: 8 },
    { key: "pdf", count: 6 },
    { key: "data-analysis", count: 4 },
  ],
  last_scan_at: null,
  pending: { by_kind: { recovery: 1, security_finding: 2, trial_due: 1 }, total: 4 },
  project_count: 3,
  recent_operations: [],
  recovery_state: "clean",
  skill_count: 27,
};

/**
 * 任务 9 §7.4 桩需求（任务 10 接线）：确定性关系摘要事实。三个冻结计数
 * （图谱=candidates 数、冲突=workspace cases 数、治理=ledger total）让 e2e
 * 的指标带与缩略带断言在真实渲染路径下可复现；纯内存、无盘/无网络。
 */
const previewCandidates: SkillRelationshipCandidate[] = [
  {
    display_name: "PDF Reader",
    last_verified_at: "2026-09-10T08:00:00Z",
    matched_alias: null,
    relationship_count: 3,
    relationship_revision: "preview-rel-1",
    runtime_name: "pdf-reader",
    skill_id: "pdf-reader",
    tags: ["documents"],
  },
  {
    display_name: "DOCX Writer",
    last_verified_at: "2026-09-10T08:00:00Z",
    matched_alias: null,
    relationship_count: 2,
    relationship_revision: "preview-rel-1",
    runtime_name: "docx-writer",
    skill_id: "docx-writer",
    tags: ["documents"],
  },
  {
    display_name: "Web Clipper",
    last_verified_at: "2026-09-10T08:00:00Z",
    matched_alias: null,
    relationship_count: 1,
    relationship_revision: "preview-rel-1",
    runtime_name: "web-clipper",
    skill_id: "web-clipper",
    tags: ["automation"],
  },
  {
    display_name: "Release Notes",
    last_verified_at: "2026-09-10T08:00:00Z",
    matched_alias: null,
    relationship_count: 2,
    relationship_revision: "preview-rel-1",
    runtime_name: "release-notes",
    skill_id: "release-notes",
    tags: ["automation"],
  },
];

function previewConflictCase(conflictId: string): ConflictWorkspace["cases"][number] {
  return {
    case: {
      classification: "uncertain" as const,
      conflict_id: conflictId,
      evidence: { fingerprints_match: null, names_match: true, sufficient_identity_evidence: false },
      member_skill_ids: [],
    },
    latest_analysis: null,
    analysis_stale: false,
    recommended_decision: null,
  };
}

const previewConflictWorkspace: ConflictWorkspace = {
  cases: [previewConflictCase("conflict-preview-1"), previewConflictCase("conflict-preview-2")],
  handled: [],
  handled_count: 1,
  last_verified_at: "2026-09-10T08:00:00Z",
  relationship_revision: "preview-rel-1",
};

const previewGovernanceLedger: RelationGovernanceLedger = {
  bucket: "all",
  counts: { all: 9, blocked: 2, eligible_to_centralize: 4, needs_validation: 3, status_normal: 0, status_retained: 0, status_needs_validation: 3, status_needs_attention: 0, status_blocked: 2, source_copies: 0, deployments: 0 },
  last_verified_at: "2026-09-10T08:00:00Z",
  relationship_revision: "preview-rel-1",
  rows: [],
  total: 9,
};

/**
 * DEV-only deterministic relationship facade for /__preview/overview. The
 * graph query is not part of the overview surface, so the stub refuses it
 * loudly instead of pretending to serve data.
 */
export const overviewPreviewRelationshipsFacade: RelationshipsFacade = {
  getConflictWorkspace: async () => previewConflictWorkspace,
  async getGraph() {
    throw new Error("the overview preview does not consume the relationship graph query");
  },
  listCandidates: async () => previewCandidates,
  listGovernance: async () => previewGovernanceLedger,
};

/**
 * DEV-only overview board (/__preview/overview). The shell provides the same
 * AppShell context as the production route while serving the fixture snapshot;
 * it never enters the production bundle (router registers it behind import
 * meta.env.DEV).
 */
export function OverviewPreviewShell() {
  return (
    <AppShell
      refreshSnapshot={async () => undefined}
      snapshot={OVERVIEW_PREVIEW_SNAPSHOT}
      verification={{ kind: "unavailable" }}
    />
  );
}
