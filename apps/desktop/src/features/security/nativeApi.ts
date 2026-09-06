import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type LlmSafetyCheckResult,
  type SetMetadata,
  type SkillLifecycle,
} from "../../api/bindings";
import type { SecurityCheck, SecurityCheckKind, SecurityFacade, SecurityFinding, SecurityPreferences } from "./api";

function checkResult(result: AppQueryResult): SecurityCheck {
  if (result.type === "basic_check_result") return { kind: "basic", state: result.payload.state, checkedAt: result.payload.checked_at ?? undefined, findingCount: result.payload.finding_count, actionableCount: result.payload.actionable_count };
  if (result.type === "llm_safety_check_result") return { kind: "llm", state: result.payload.state, checkedAt: result.payload.checked_at ?? undefined, findingCount: result.payload.finding_count, actionableCount: result.payload.actionable_count };
  throw new Error("安全检查查询返回了无法识别的结果");
}

function findingsResult(result: AppQueryResult, kind: SecurityCheckKind): SecurityFinding[] {
  if (result.type !== "findings") throw new Error("安全发现项查询返回了无法识别的结果");
  return result.payload.map((finding) => ({
    id: finding.id,
    code: finding.code,
    kind,
    severity: finding.severity === "critical" ? "critical" : finding.severity === "error" ? "high" : finding.severity === "warning" ? "medium" : "low",
    file: finding.file ?? undefined,
    line: finding.line_start ?? undefined,
    lineEnd: finding.line_end ?? undefined,
    highRisk: finding.high_risk,
    disposition: finding.disposition,
    message: finding.code,
  }));
}

async function resolvedVersion(skillId: string, versionId: string): Promise<string> {
  if (versionId !== "current") return versionId;
  const result = await queryApplication({ type: "get_skill", payload: { skill_id: skillId } });
  if (result.type !== "skill" || !result.payload.current_version) throw new Error("该 Skill 尚无可检查版本");
  return result.payload.current_version;
}

export const nativeSecurityFacade: SecurityFacade = {
  async getChecks(skillId, versionId) {
    const resolved = await resolvedVersion(skillId, versionId);
    const [basic, llm] = await Promise.all([
      queryApplication({ type: "get_basic_check_result", payload: { skill_id: skillId, version_id: resolved } }),
      queryApplication({ type: "get_llm_safety_check_result", payload: { skill_id: skillId, version_id: resolved } }),
    ]);
    return [checkResult(basic), checkResult(llm)];
  },
  async listFindings(skillId, versionId) {
    const resolved = await resolvedVersion(skillId, versionId);
    const [basic, llm] = await Promise.all([
      queryApplication({ type: "list_findings", payload: { skill_id: skillId, version_id: resolved, kind: "basic" } }),
      queryApplication({ type: "list_findings", payload: { skill_id: skillId, version_id: resolved, kind: "llm" } }),
    ]);
    return [...findingsResult(basic, "basic"), ...findingsResult(llm, "llm")];
  },
  async setFindingDisposition(finding, disposition, skillId, versionId, highRiskConfirmed) {
    if (!skillId || !versionId) throw new Error("安全发现项缺少 Skill 版本上下文");
    if (finding.highRisk && disposition !== "actionable" && !highRiskConfirmed) {
      throw new Error("高风险发现项的处置需要显式确认");
    }
    const result = await executeCommand({ type: "set_finding_disposition", payload: { skill_id: skillId, version_id: versionId, kind: finding.kind, finding_id: finding.id, disposition, high_risk_confirmed: highRiskConfirmed } });
    if (result.type !== "basic_check_result" && result.type !== "llm_safety_check_result") throw new Error("安全发现项处置返回了无法识别的结果");
  },
  async getPreferences() {
    const result = await queryApplication({ type: "get_desktop_preferences" });
    if (result.type !== "desktop_preferences") throw new Error("桌面偏好设置查询返回了无法识别的结果");
    return { llmProvider: result.payload.llm_provider, dataScope: result.payload.data_scope } satisfies SecurityPreferences;
  },
  async runLlmCheck(skillId, versionId) {
    await runNativeLlmSafetyCheck(skillId, await resolvedVersion(skillId, versionId));
  },
  async cancelLlmCheck(operationId) {
    const result = await executeCommand({
      type: "cancel_operation",
      payload: { operation_id: operationId },
    });
    if (result.type !== "operation_summary") {
      throw new Error("取消操作返回了无法识别的结果");
    }
  },
  async listRunningLlmChecks() {
    const result = await queryApplication({ type: "list_running_llm_checks" });
    if (result.type !== "running_llm_checks") {
      throw new Error("运行中检查查询返回了无法识别的结果");
    }
    return result.payload.map((run) => ({
      skillId: run.skill_id,
      versionId: run.version_id,
      operationId: run.operation_id,
    }));
  },
};

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
