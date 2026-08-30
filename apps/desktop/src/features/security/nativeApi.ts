import {
  executeCommand,
  type AppCommandResult,
  type LlmSafetyCheckResult,
  type SetMetadata,
  type SkillLifecycle,
} from "../../api/bindings";

type OperationSummary = Extract<AppCommandResult, { type: "operation_summary" }>["payload"];

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

function operationSummary(result: AppCommandResult): OperationSummary {
  if (result.type !== "operation_summary") {
    throw new Error("技能元数据操作返回了无法识别的结果");
  }
  return result.payload;
}

export async function renameNativeSkill(skillId: string, name: string): Promise<OperationSummary> {
  return operationSummary(await executeCommand({
    type: "rename_skill",
    payload: { skill_id: skillId, name },
  }));
}

export async function setNativeSkillMetadata(
  skillId: string,
  metadata: Omit<SetMetadata, "skill_id">,
): Promise<OperationSummary> {
  return operationSummary(await executeCommand({
    type: "set_metadata",
    payload: { skill_id: skillId, ...metadata },
  }));
}

export async function setNativeSkillLifecycle(
  skillId: string,
  lifecycle: SkillLifecycle,
): Promise<OperationSummary> {
  return operationSummary(await executeCommand({
    type: "set_lifecycle",
    payload: { skill_id: skillId, lifecycle },
  }));
}

export async function setNativeSkillTrial(
  skillId: string,
  due: [number, number, number] | null,
): Promise<OperationSummary> {
  return operationSummary(await executeCommand({
    type: "set_trial",
    payload: { skill_id: skillId, due },
  }));
}
