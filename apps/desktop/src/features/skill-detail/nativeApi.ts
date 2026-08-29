import { queryApplication, type AppQueryResult, type SkillResult } from "../../api/bindings";
import {
  SkillDetailUnavailableError,
  unavailableSkillDetailFacade,
  type SkillDetailFacade,
  type SkillDetailSummary,
  type SkillMetadata,
} from "./api";

function unavailableResult(): SkillDetailUnavailableError {
  return new SkillDetailUnavailableError();
}

function asSkill(result: AppQueryResult): SkillResult {
  if (result.type !== "skill") throw unavailableResult();
  return result.payload;
}

function lifecycleOf(skill: SkillResult): SkillDetailSummary["lifecycle"] {
  if (skill.trial_due) return "trial";
  return skill.lifecycle === "Normal" ? "active" : "archived";
}

async function getSkill(skillId: string): Promise<SkillResult> {
  try {
    return asSkill(
      await queryApplication({ type: "get_skill", payload: { skill_id: skillId } }),
    );
  } catch (error) {
    if (error instanceof SkillDetailUnavailableError) throw error;
    throw unavailableResult();
  }
}

function summaryOf(skill: SkillResult): SkillDetailSummary {
  return {
    agentDeploymentCount: 0,
    aiCheck: "not_run",
    basicCheck: "not_run",
    currentVersion: skill.current_version ?? "unknown",
    highRiskCount: 0,
    id: skill.skill_id,
    lifecycle: lifecycleOf(skill),
    name: skill.display_name,
    pendingCount: 0,
    projectDeploymentCount: 0,
    purpose: skill.translated_description ?? skill.original_description,
    trialDue: skill.trial_due ?? undefined,
    upgradeAvailable: false,
  };
}

function checkStateOf(state: "not_checked" | "running" | "passed" | "failed"):
  SkillDetailSummary["basicCheck"] {
  if (state === "not_checked") return "not_run";
  if (state === "running") return "warning";
  return state;
}

async function checkState(
  skillId: string,
  versionId: string,
  kind: "basic" | "llm",
): Promise<SkillDetailSummary["basicCheck"]> {
  const result = await queryApplication(
    kind === "basic"
      ? { type: "get_basic_check_result", payload: { skill_id: skillId, version_id: versionId } }
      : { type: "get_llm_safety_check_result", payload: { skill_id: skillId, version_id: versionId } },
  );
  const expectedType = kind === "basic" ? "basic_check_result" : "llm_safety_check_result";
  if (result.type !== expectedType) throw unavailableResult();
  return checkStateOf(result.payload.state);
}

function metadataOf(skill: SkillResult): SkillMetadata {
  return {
    license: skill.license ?? undefined,
    note: skill.user_note ?? undefined,
    originalDescription: skill.original_description,
    purpose: skill.translated_description ?? skill.original_description,
    tags: skill.tags,
  };
}

/** Real IPC-backed detail reads. Mutations and secondary panels remain on the
 * unavailable facade until their native contracts are connected. */
export const nativeSkillDetailFacade: SkillDetailFacade = {
  ...unavailableSkillDetailFacade,
  async getSummary(skillId) {
    const skill = await getSkill(skillId);
    const summary = summaryOf(skill);
    if (!skill.current_version) return summary;
    const [basicCheck, aiCheck] = await Promise.all([
      checkState(skillId, skill.current_version, "basic"),
      checkState(skillId, skill.current_version, "llm"),
    ]);
    return { ...summary, aiCheck, basicCheck };
  },
  async getMetadata(skillId) {
    return metadataOf(await getSkill(skillId));
  },
};
