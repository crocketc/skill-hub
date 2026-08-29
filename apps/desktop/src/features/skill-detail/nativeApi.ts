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
    return summaryOf(await getSkill(skillId));
  },
  async getMetadata(skillId) {
    return metadataOf(await getSkill(skillId));
  },
};
