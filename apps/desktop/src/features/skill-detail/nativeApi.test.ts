import { describe, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import {
  nativeSkillDetailFacade,
  setNativeCurrentVersion,
  setNativeFindingDisposition,
} from "./nativeApi";

vi.mock("../../api/bindings", () => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));

describe("native skill detail facade", () => {
  it("maps the native skill projection to summary and metadata", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "skill",
      payload: {
        skill_id: "skill-1",
        display_name: "PDF Reader",
        runtime_name: "pdf-reader",
        original_description: "Extract tables",
        translated_description: "提取表格",
        user_note: "Review before deployment",
        tags: ["documents", "pdf"],
        license: "MIT",
        lifecycle: "Normal",
        trial_due: "2026-09-15",
        current_version: null,
      },
    });

    await expect(nativeSkillDetailFacade.getSummary("skill-1")).resolves.toMatchObject({
      id: "skill-1",
      name: "PDF Reader",
      purpose: "提取表格",
      lifecycle: "trial",
      trialDue: "2026-09-15",
    });
    await expect(nativeSkillDetailFacade.getMetadata("skill-1")).resolves.toMatchObject({
      originalDescription: "Extract tables",
      purpose: "提取表格",
      note: "Review before deployment",
      tags: ["documents", "pdf"],
      license: "MIT",
    });
    expect(queryApplication).toHaveBeenCalledTimes(2);
  });

  it("turns an unexpected native result into the standard unavailable error", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication).mockResolvedValue({
      type: "bootstrap_snapshot",
      payload: {
        skill_count: 0,
        project_count: 0,
        agent_count: 0,
        deployed_count: 0,
        deployment_categories: [],
        recent_operations: [],
        pending: { total: 0, by_kind: {} },
        last_scan_at: null,
        recovery_state: "clean",
      },
    });

    await expect(nativeSkillDetailFacade.getSummary("skill-1")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error && error.name === "SkillDetailUnavailableError",
    );
  });

  it("maps independent native check states when a current version exists", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication)
      .mockResolvedValueOnce({
        type: "skill",
        payload: {
          skill_id: "skill-1",
          display_name: "PDF Reader",
          runtime_name: "pdf-reader",
          original_description: "Extract tables",
          translated_description: null,
          user_note: null,
          tags: [],
          license: null,
          lifecycle: "Normal",
          trial_due: null,
          current_version: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      })
      .mockResolvedValueOnce({
        type: "basic_check_result",
        payload: {
          skill_id: "skill-1",
          version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          state: "passed",
          run_id: "basic-run",
          ruleset_id: "rules-v1",
          checked_at: "2026-08-29T00:00:00Z",
          finding_count: 0,
          actionable_count: 0,
        },
      })
      .mockResolvedValueOnce({
        type: "llm_safety_check_result",
        payload: {
          skill_id: "skill-1",
          version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          state: "failed",
          run_id: "llm-run",
          model_id: "model-v1",
          checked_at: "2026-08-29T00:00:00Z",
          finding_count: 1,
          actionable_count: 1,
        },
      });

    await expect(nativeSkillDetailFacade.getSummary("skill-1")).resolves.toMatchObject({
      basicCheck: "passed",
      aiCheck: "failed",
      currentVersion: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(queryApplication).toHaveBeenCalledTimes(3);
  });

  it("maps structured findings for the selected check kind", async () => {
    vi.clearAllMocks();
    vi.mocked(queryApplication).mockResolvedValue({
      type: "findings",
      payload: [{
        id: "finding-1",
        code: "prompt_injection",
        severity: "critical",
        file: "SKILL.md",
        line_start: 4,
        line_end: 4,
        disposition: "actionable",
        high_risk: true,
      }],
    });

    await expect(nativeSkillDetailFacade.getFindings(
      "skill-1",
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "basic",
    )).resolves.toEqual([{
      id: "finding-1",
      code: "prompt_injection",
      severity: "critical",
      file: "SKILL.md",
      disposition: "actionable",
      highRisk: true,
    }]);
  });

  it("submits an explicit finding disposition through the typed native command", async () => {
    vi.clearAllMocks();
    vi.mocked(executeCommand).mockResolvedValue({
      type: "basic_check_result",
      payload: {
        skill_id: "skill-1",
        version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: "passed",
        run_id: "basic-run",
        ruleset_id: "basic-v1",
        checked_at: "2026-08-29T00:00:00Z",
        finding_count: 1,
        actionable_count: 0,
      },
    });

    await expect(setNativeFindingDisposition(
      "skill-1",
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "basic",
      "finding-1",
      "acknowledged",
      true,
    )).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_finding_disposition",
      payload: {
        skill_id: "skill-1",
        version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        kind: "basic",
        finding_id: "finding-1",
        disposition: "acknowledged",
        high_risk_confirmed: true,
      },
    });
  });

  it("switches the current version through the typed native command", async () => {
    vi.clearAllMocks();
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: {
        operation_id: "op-1",
        phase: "committed",
        message_code: "catalog.current_version_changed",
        error_code: null,
      },
    });

    await expect(setNativeCurrentVersion("skill-1", "sha256:bbb")).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "set_current_version",
      payload: { skill_id: "skill-1", version_id: "sha256:bbb" },
    });
  });
});
