import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import {
  renameNativeSkill,
  runNativeLlmSafetyCheck,
  setNativeSkillLifecycle,
  setNativeSkillMetadata,
  setNativeSkillTrial,
  nativeSecurityFacade,
} from "./nativeApi";

vi.mock("../../api/bindings", async () => {
  const original = await vi.importActual<typeof import("../../api/bindings")>("../../api/bindings");
  return { ...original, executeCommand: vi.fn(), queryApplication: vi.fn() };
});

describe("security native API", () => {
  beforeEach(() => {
    vi.mocked(executeCommand).mockReset();
    vi.mocked(queryApplication).mockReset();
  });

  it("maps basic and LLM checks plus findings from native queries", async () => {
    vi.mocked(queryApplication)
      .mockResolvedValueOnce({ type: "basic_check_result", payload: {
        state: "passed", checked_at: "2026-09-01T00:00:00Z", finding_count: 1, actionable_count: 1,
      } as never })
      .mockResolvedValueOnce({ type: "llm_safety_check_result", payload: {
        state: "not_checked", checked_at: null, finding_count: 0, actionable_count: 0,
      } as never })
      .mockResolvedValueOnce({ type: "findings", payload: [{
        id: "finding-1", code: "secret", severity: "error", file: "SKILL.md", line_start: 4, line_end: 4,
        disposition: "actionable", high_risk: true,
      }] });

    await expect(nativeSecurityFacade.getChecks("skill-1", "version-1")).resolves.toEqual([
      expect.objectContaining({ kind: "basic", state: "passed", findingCount: 1 }),
      expect.objectContaining({ kind: "llm", state: "not_checked", findingCount: 0 }),
    ]);
    await expect(nativeSecurityFacade.listFindings("skill-1", "version-1")).resolves.toEqual([{
      id: "finding-1", code: "secret", severity: "high", file: "SKILL.md", line: 4,
      highRisk: true, disposition: "actionable", message: "secret",
    }]);
  });

  it("runs an LLM safety check through the generated command binding", async () => {
    const payload = {
      skill_id: "skill-1",
      version_id: "version-1",
      state: "failed" as const,
      run_id: "llm-safety-version-1-0",
      model_id: "test-model",
      checked_at: "2026-08-30T00:00:00Z",
      finding_count: 1,
      actionable_count: 1,
    };
    vi.mocked(executeCommand).mockResolvedValue({ type: "llm_safety_check_result", payload });

    await expect(runNativeLlmSafetyCheck("skill-1", "version-1")).resolves.toEqual(payload);
    expect(executeCommand).toHaveBeenCalledWith({
      type: "run_llm_safety_check",
      payload: { skill_id: "skill-1", version_id: "version-1" },
    });
  });

  it("uses the recheck command when requested and rejects unexpected results", async () => {
    vi.mocked(executeCommand).mockResolvedValue({ type: "basic_check_result", payload: {} as never });

    await expect(runNativeLlmSafetyCheck("skill-1", "version-1", true)).rejects.toThrow(
      "LLM 安全检查返回了无法识别的结果",
    );
    expect(executeCommand).toHaveBeenCalledWith({
      type: "recheck_llm_safety",
      payload: { skill_id: "skill-1", version_id: "version-1" },
    });
  });

  it("maps catalog metadata mutations to typed commands", async () => {
    const summary = {
      operation_id: "op-1",
      phase: "committed" as const,
      message_code: "catalog.updated",
      error_code: null,
    };
    vi.mocked(executeCommand).mockResolvedValue({ type: "operation_summary", payload: summary });

    await renameNativeSkill("skill-1", "Renamed");
    await setNativeSkillMetadata("skill-1", {
      display_name: null,
      note: "note",
      tags: ["tag"],
      author: null,
      license: "MIT",
    });
    await setNativeSkillLifecycle("skill-1", "Deprecated");
    await setNativeSkillTrial("skill-1", [2026, 9, 1]);

    expect(executeCommand).toHaveBeenNthCalledWith(1, {
      type: "rename_skill",
      payload: { skill_id: "skill-1", name: "Renamed" },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(2, {
      type: "set_metadata",
      payload: { skill_id: "skill-1", display_name: null, note: "note", tags: ["tag"], author: null, license: "MIT" },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(3, {
      type: "set_lifecycle",
      payload: { skill_id: "skill-1", lifecycle: "Deprecated" },
    });
    expect(executeCommand).toHaveBeenNthCalledWith(4, {
      type: "set_trial",
      payload: { skill_id: "skill-1", due: [2026, 9, 1] },
    });
  });
});
