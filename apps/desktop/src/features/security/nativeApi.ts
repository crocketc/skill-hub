import {
  executeCommand,
  type AppCommandResult,
  type LlmSafetyCheckResult,
} from "../../api/bindings";

function llmSafetyResult(result: AppCommandResult): LlmSafetyCheckResult {
  if (result.type !== "llm_safety_check_result") {
    throw new Error("LLM 安全检查返回了无法识别的结果");
  }
  return result.payload;
}

export async function runNativeLlmSafetyCheck(
  skillId: string,
  versionId: string,
  recheck = false,
): Promise<LlmSafetyCheckResult> {
  return llmSafetyResult(await executeCommand({
    type: recheck ? "recheck_llm_safety" : "run_llm_safety_check",
    payload: { skill_id: skillId, version_id: versionId },
  }));
}
