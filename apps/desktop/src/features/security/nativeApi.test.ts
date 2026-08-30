import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeCommand } from "../../api/bindings";
import { runNativeLlmSafetyCheck } from "./nativeApi";

vi.mock("../../api/bindings", async () => {
  const original = await vi.importActual<typeof import("../../api/bindings")>("../../api/bindings");
  return { ...original, executeCommand: vi.fn() };
});

describe("security native API", () => {
  beforeEach(() => {
    vi.mocked(executeCommand).mockReset();
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
});
