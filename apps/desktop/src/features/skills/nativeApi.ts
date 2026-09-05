import {
  executeCommand,
  queryApplication,
  type AppQueryResult,
  type CheckState as NativeCheckState,
  type DeploymentTarget,
  type SkillListItem,
  type SkillSortColumn,
} from "../../api/bindings";
import {
  SkillLibraryUnavailableError,
  unavailableSkillLibraryFacade,
  type AgentDeployment,
  type CheckState,
  type SkillColumnId,
  type SkillDrawerPreferences,
  type SkillLibraryFacade,
  type SkillQuickView,
  type SkillTablePreferences,
  type SkillTableRow,
} from "./api";

function unavailableResult(): SkillLibraryUnavailableError {
  return new SkillLibraryUnavailableError();
}

function lifecycleOf(item: SkillListItem): SkillTableRow["lifecycle"] {
  if (item.trial_due) return "trial";
  return item.lifecycle === "Normal" ? "active" : "archived";
}

function checkStateOf(state: NativeCheckState): CheckState {
  if (state === "not_checked") return "not_run";
  if (state === "running") return "warning";
  return state;
}

function nativeCheckStateOf(state: CheckState): NativeCheckState {
  if (state === "not_run") return "not_checked";
  if (state === "warning") return "running";
  if (state === "passed" || state === "failed") return state;
  throw unavailableResult();
}

const SORT_COLUMNS: Partial<Record<SkillColumnId, SkillSortColumn>> = {
  name: "name",
  lifecycle: "lifecycle",
  agent_deployments: "agent_deployments",
  project_deployments: "project_deployments",
  version: "version",
};

/** Columns whose sorting has a real native read model; the table disables the
 * remaining sort controls so the page never issues an unavailable query. */
export const NATIVE_SORTABLE_COLUMNS: SkillColumnId[] = [
  "name",
  "lifecycle",
  "agent_deployments",
  "project_deployments",
  "version",
];

/** The upgrade filter needs upstream source data that has no read model yet,
 * so the filter control stays disabled instead of failing the whole page. */
export const NATIVE_VERSION_UPGRADE_FILTER_SUPPORTED = false;

function toTableRow(item: SkillListItem, agentTargets: Map<string, AgentDeployment>): SkillTableRow {
  const agentDeployments = item.agent_deployment_target_ids.map(
    (targetId) => agentTargets.get(targetId) ?? { id: targetId, name: targetId },
  );
  return {
    aiCheck: checkStateOf(item.ai_check),
    agentDeploymentCount: item.agent_deployment_count,
    agentDeployments,
    basicCheck: checkStateOf(item.basic_check),
    currentVersion: item.current_version_label ?? "unknown",
    highRiskCount: item.high_risk_count,
    id: item.skill_id,
    invocation: undefined,
    lifecycle: lifecycleOf(item),
    name: item.display_name,
    originalDescription: item.original_description,
    ownership: item.author ?? undefined,
    pendingCount: 0,
    projectDeploymentCount: item.project_deployment_count,
    purpose: item.translated_description ?? item.original_description,
    requirements: [],
    source: item.source_locator ?? item.source_kind ?? undefined,
    tags: item.tags,
    translatedDescription: item.translated_description ?? undefined,
    license: item.license ?? undefined,
    upgradeAvailable: false,
  };
}

async function loadAgentTargetLabels(): Promise<Map<string, AgentDeployment>> {
  const map = new Map<string, AgentDeployment>();
  try {
    const result = await queryApplication({ type: "list_deployment_targets", payload: null });
    if (result.type !== "deployment_targets") return map;
    for (const target of result.payload as DeploymentTarget[]) {
      map.set(target.id, { id: target.physical_id, name: target.label });
    }
  } catch {
    // Agent names are an enhancement; counts stay real when the lookup fails.
  }
  return map;
}

function asSkillPage(result: AppQueryResult) {
  if (result.type !== "skill_page") throw unavailableResult();
  return result.payload;
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

/** Real IPC-backed read facade. Mutations and preference persistence remain
 * on the unavailable facade until their native contracts are connected. */
async function readUiPreference(key: string): Promise<string> {
  const result = await queryApplication({ type: "get_ui_preference", payload: { key } });
  if (result.type !== "ui_preference") throw unavailableResult();
  if (!result.payload.value_json) throw unavailableResult();
  return result.payload.value_json;
}

export const nativeSkillLibraryFacade: SkillLibraryFacade = {
  ...unavailableSkillLibraryFacade,
  async listSkills(query) {
    const sortColumn = SORT_COLUMNS[query.sort.column];
    if (!sortColumn) throw unavailableResult();
    if (query.filters.version !== "any") throw unavailableResult();
    const filters = {
      ai_check: query.filters.aiCheck.map(nativeCheckStateOf),
      basic_check: query.filters.basicCheck.map(nativeCheckStateOf),
      deployment: query.filters.deployment,
      lifecycle: query.filters.lifecycle,
      tags: query.filters.tags,
    };
    try {
      const result = await queryApplication({
        type: "list_skills",
        payload: {
          text: query.text,
          page: query.page,
          page_size: query.pageSize,
          filters,
          sort: { column: sortColumn, direction: query.sort.direction },
        },
      });
      const payload = asSkillPage(result);
      const needsAgentLabels = payload.items.some(
        (item) => item.agent_deployment_target_ids.length > 0,
      );
      const agentTargets = needsAgentLabels ? await loadAgentTargetLabels() : new Map();
      return {
        facets: { tags: payload.tags },
        items: payload.items.map((item) => toTableRow(item, agentTargets)),
        page: payload.page,
        pageSize: payload.page_size,
        total: payload.total,
      };
    } catch (error) {
      if (error instanceof SkillLibraryUnavailableError) throw error;
      throw unavailableResult();
    }
  },
  async loadTablePreferences() {
    return JSON.parse(await readUiPreference("table_preferences")) as SkillTablePreferences;
  },
  async saveTablePreferences(preferences) {
    await executeCommand({
      type: "set_ui_preference",
      payload: { key: "table_preferences", value_json: JSON.stringify(preferences) },
    });
  },
  async loadDrawerPreferences() {
    return JSON.parse(await readUiPreference("drawer_preferences")) as SkillDrawerPreferences;
  },
  async saveDrawerPreferences(preferences) {
    await executeCommand({
      type: "set_ui_preference",
      payload: { key: "drawer_preferences", value_json: JSON.stringify(preferences) },
    });
  },
  async getSkillQuickView(skillId) {
    try {
      const result = await queryApplication({
        type: "get_skill",
        payload: { skill_id: skillId },
      });
      if (result.type !== "skill") throw unavailableResult();
      const skill = result.payload;
      const view = asQuickView(result);
      // 用真实读模型填充抽屉各模块（FE-05）：身份/版本/检查/部署关系。
      view.currentVersion = skill.current_version ?? "unknown";
      view.purpose = skill.translated_description ?? skill.original_description;
      view.originalDescription = skill.original_description;
      view.translatedDescription = skill.translated_description ?? undefined;
      view.tags = skill.tags;
      view.license = skill.license ?? undefined;
      view.note = skill.user_note ?? undefined;
      view.lifecycle = skill.trial_due ? "trial" : skill.lifecycle === "Normal" ? "active" : "archived";
      if (skill.current_version) {
        const checks = await Promise.all([
          queryApplication({ type: "get_basic_check_result", payload: { skill_id: skillId, version_id: skill.current_version } }),
          queryApplication({ type: "get_llm_safety_check_result", payload: { skill_id: skillId, version_id: skill.current_version } }),
        ]).catch(() => [] as AppQueryResult[]);
        if (checks[0]?.type === "basic_check_result") view.basicCheck = checkStateOf(checks[0].payload.state);
        if (checks[1]?.type === "llm_safety_check_result") view.aiCheck = checkStateOf(checks[1].payload.state);
      }
      try {
        const relations = await queryApplication({ type: "get_deployment_relations", payload: { skill_id: skillId } });
        if (relations.type === "deployment_relations") {
          view.agentDeployments = relations.payload.map((record) => ({ id: record.id, name: record.runtime_name }));
          view.agentDeploymentCount = relations.payload.length;
        }
      } catch {
        // 部署关系读取失败时保持占位零值，不在抽屉里伪造数据。
      }
      return view;
    } catch (error) {
      if (error instanceof SkillLibraryUnavailableError) throw error;
      throw unavailableResult();
    }
  },
};
