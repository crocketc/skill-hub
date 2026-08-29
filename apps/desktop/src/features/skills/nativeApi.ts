import {
  queryApplication,
  type AppQueryResult,
  type SkillListItem,
} from "../../api/bindings";
import {
  SkillLibraryUnavailableError,
  unavailableSkillLibraryFacade,
  type SkillLibraryFacade,
  type SkillQuickView,
  type SkillTableRow,
} from "./api";

function unavailableResult(): SkillLibraryUnavailableError {
  return new SkillLibraryUnavailableError();
}

function lifecycleOf(item: SkillListItem): SkillTableRow["lifecycle"] {
  if (item.trial_due) return "trial";
  return item.lifecycle === "Normal" ? "active" : "archived";
}

function toTableRow(item: SkillListItem): SkillTableRow {
  return {
    aiCheck: "not_run",
    agentDeploymentCount: 0,
    basicCheck: "not_run",
    currentVersion: "unknown",
    highRiskCount: 0,
    id: item.skill_id,
    invocation: undefined,
    lifecycle: lifecycleOf(item),
    name: item.display_name,
    originalDescription: item.original_description,
    ownership: undefined,
    pendingCount: 0,
    projectDeploymentCount: 0,
    purpose: item.translated_description ?? item.original_description,
    requirements: [],
    source: undefined,
    tags: item.tags,
    translatedDescription: item.translated_description ?? undefined,
    license: item.license ?? undefined,
    upgradeAvailable: false,
  };
}

function asSkillPage(result: AppQueryResult) {
  if (result.type !== "skill_page") throw unavailableResult();
  return {
    facets: { tags: result.payload.tags },
    items: result.payload.items.map(toTableRow),
    page: result.payload.page,
    pageSize: result.payload.page_size,
    total: result.payload.total,
  };
}

function asQuickView(result: AppQueryResult): SkillQuickView {
  if (result.type !== "skill") throw unavailableResult();
  const row: SkillTableRow = {
    aiCheck: "not_run",
    agentDeploymentCount: 0,
    basicCheck: "not_run",
    currentVersion: "unknown",
    highRiskCount: 0,
    id: result.payload.skill_id,
    lifecycle: "active",
    name: result.payload.display_name,
    pendingCount: 0,
    projectDeploymentCount: 0,
    purpose: "",
    requirements: [],
    tags: [],
    upgradeAvailable: false,
  };
  return {
    ...row,
    dependencies: [],
    duplicateCandidates: [],
    externalChanges: [],
  };
}

function supportsNativeQuery(query: Parameters<SkillLibraryFacade["listSkills"]>[0]): boolean {
  const { filters, sort } = query;
  return (
    filters.aiCheck.length === 0 &&
    filters.basicCheck.length === 0 &&
    filters.deployment === "any" &&
    filters.lifecycle.length === 0 &&
    filters.tags.length === 0 &&
    filters.version === "any" &&
    sort.column === "name" &&
    sort.direction === "asc"
  );
}

/** Real IPC-backed read facade. Mutations and preference persistence remain
 * on the unavailable facade until their native contracts are connected. */
export const nativeSkillLibraryFacade: SkillLibraryFacade = {
  ...unavailableSkillLibraryFacade,
  async listSkills(query) {
    if (!supportsNativeQuery(query)) throw unavailableResult();
    try {
      const result = await queryApplication({
        type: "list_skills",
        payload: { text: query.text, page: query.page, page_size: query.pageSize },
      });
      return asSkillPage(result);
    } catch (error) {
      if (error instanceof SkillLibraryUnavailableError) throw error;
      throw unavailableResult();
    }
  },
  async getSkillQuickView(skillId) {
    try {
      const result = await queryApplication({
        type: "get_skill",
        payload: { skill_id: skillId },
      });
      return asQuickView(result);
    } catch (error) {
      if (error instanceof SkillLibraryUnavailableError) throw error;
      throw unavailableResult();
    }
  },
};
