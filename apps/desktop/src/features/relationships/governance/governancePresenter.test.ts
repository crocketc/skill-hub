import { describe, expect, it } from "vitest";
import type { UsageHealthReason, UsageRelationView } from "../../../api/bindings";
import { presentGovernanceRow } from "./governancePresenter";

function usageView(overrides: Partial<UsageRelationView> = {}): UsageRelationView {
  return {
    relation_id: "usage-1",
    skill_id: "skill-1",
    target: {
      kind: "agent",
      directory_id: "directory-1",
      agent_client_id: "codex-cli",
      directory_role: "agent_user",
      recognition: "supported",
    },
    entry_key: { directory_id: "directory-1", relative_entry_path: "skill-a" },
    form: "full_copy",
    management: "unmanaged",
    health_reasons: ["normal"],
    decision: null,
    decision_history_ids: [],
    active: true,
    file_representation: "directory",
    link_target_path: null,
    link_target_path_key: null,
    link_target_directory_id: null,
    physical_source_ids_evidence: [],
    evidence_relation_ids: ["rel-1"],
    ...overrides,
  };
}

describe("presentGovernanceRow（统一使用关系）", () => {
  it("uses active health and management facts instead of legacy completion fields", () => {
    const unmanaged = presentGovernanceRow(usageView());
    expect(unmanaged.classificationKey).toBe("relationships.governance.classification.pending");
    expect(unmanaged.managementKey).toBe("relationships.governance.usageManagement.unmanaged");
    expect(unmanaged.summaryKey).toBe("relationships.governance.shortName.unmanaged");
    expect(unmanaged.decisionKey).toBeNull();

    const managed = presentGovernanceRow(usageView({ management: "managed" }));
    expect(managed.classificationKey).toBe("relationships.governance.classification.no_action");
    expect(managed.summaryKey).toBe("relationships.governance.shortName.healthy");
  });

  it("missing_subject_does_not_imply_broken_link", () => {
    const presentation = presentGovernanceRow(usageView({
      skill_id: null,
      health_reasons: ["user_confirmation", "unable_to_verify"],
    }));

    expect(presentation.reasonKeys).toEqual(["user_confirmation", "unable_to_verify"]);
    expect(presentation.reasonKeys).not.toContain("link_abnormal");
    expect(presentation.summaryKey).not.toBe("relationships.governance.shortName.link_abnormal");
  });

  it("maps every health reason and preserves co-occurring reasons", () => {
    const reasons: UsageHealthReason[] = [
      "normal",
      "file_missing",
      "link_abnormal",
      "content_changed",
      "needs_sync",
      "sync_failed",
      "unable_to_verify",
      "user_confirmation",
    ];
    for (const reason of reasons) {
      const presentation = presentGovernanceRow(usageView({ health_reasons: [reason] }));
      expect(presentation.reasonKeys).toEqual([reason]);
      expect(presentation.summaryKey).toMatch(/^relationships\.governance\.shortName\./);
      expect(presentation.tone).toMatch(/^(success|warning|danger)$/);
    }

    const multiple = presentGovernanceRow(usageView({
      health_reasons: ["file_missing", "needs_sync", "user_confirmation"],
    }));
    expect(multiple.reasonKeys).toEqual(["file_missing", "needs_sync", "user_confirmation"]);
    expect(multiple.summaryKey).toBe("relationships.governance.shortName.user_confirmation");
  });

  it("treats a healthy built-in original as no-action without a retained decision", () => {
    const presentation = presentGovernanceRow(usageView({
      target: { ...usageView().target, directory_role: "builtin" },
      health_reasons: ["normal"],
      management: "unmanaged",
    }));

    expect(presentation.classificationKey).toBe("relationships.governance.classification.no_action");
    expect(presentation.summaryKey).toBe("relationships.governance.shortName.builtin_original");
    expect(presentation.decisionKey).toBeNull();
  });
});
