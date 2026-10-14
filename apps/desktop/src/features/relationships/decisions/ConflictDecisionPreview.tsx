import type {
  ConflictResolutionOutcome,
  ConflictWorkspace,
  ResolveConflictCase,
} from "../../../api/bindings";
import { getPreviewLlmFacade } from "../../settings/SettingsLlmPreview";
import { ConflictDecisionPage } from "./ConflictDecisionPage";
import type { ConflictDecisionsFacade } from "./decisionsApi";

const PREVIEW_CONFLICT_ID = "preview-conflict-1";

const workspace: ConflictWorkspace = {
  cases: [
    {
      case: {
        conflict_id: PREVIEW_CONFLICT_ID,
        kind: "same_name_different_content",
        classification: "uncertain",
        member_skill_ids: [],
        members: [
          {
            skill_id: null,
            version_id: null,
            provenance_id: null,
            directory_node_id: null,
            path: "/preview/skills/browser-tools",
            fingerprint: "sha256:preview-a",
          },
          {
            skill_id: null,
            version_id: null,
            provenance_id: null,
            directory_node_id: null,
            path: "/preview/imports/browser-tools",
            fingerprint: "sha256:preview-b",
          },
        ],
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
    },
  ],
  handled_count: 0,
  handled: [],
  relationship_revision: "preview-r1",
  last_verified_at: null,
};

const facade: ConflictDecisionsFacade = {
  async getConflictWorkspace() {
    return workspace;
  },
  async analyzeConflict(scope) {
    return {
      scope,
      input_fingerprint: "sha256:preview-analysis",
      cases: [],
      skipped_decided_cases: 0,
      total_case_count: 1,
      source: "llm",
      failure_code: null,
    };
  },
  async resolveConflictCase(command: ResolveConflictCase): Promise<ConflictResolutionOutcome> {
    return {
      conflict_id: command.conflict_id,
      decision: command.decision,
      decided_at: "2026-10-15T00:00:00Z",
      conclusion: command.decision === "keep_distinct"
        ? "distinct_skill"
        : command.decision === "confirm_same_skill" ? "same_skill_version" : null,
      governance: null,
      relationship_revision: "preview-r2",
    };
  },
};

/** DEV-only relationship AI readiness preview. The case ID in the URL remains
 * stable so the settings round trip can prove that the caller context survives. */
export function ConflictDecisionPreview() {
  return (
    <ConflictDecisionPage
      facade={facade}
      llmFacade={getPreviewLlmFacade()}
    />
  );
}
