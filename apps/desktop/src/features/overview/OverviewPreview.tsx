import type { BootstrapSnapshot } from "../../api/bindings";
import { AppShell } from "../../app/AppShell";

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
