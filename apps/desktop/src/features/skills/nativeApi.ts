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
  // P1-10：别名只覆盖展示名；原名（runtime_name）始终单独携带，
  // 展示名与原名一致时不产生冗余别名。
  const aliased = item.display_name !== item.runtime_name;
  return {
    aiCheck: checkStateOf(item.ai_check),
    agentDeploymentCount: item.agent_deployment_count,
    agentDeployments,
    alias: aliased ? item.display_name : undefined,
    basicCheck: checkStateOf(item.basic_check),
    currentVersion: item.current_version_label ?? "unknown",
    highRiskCount: item.high_risk_count,
    id: item.skill_id,
    invocation: undefined,
    lifecycle: lifecycleOf(item),
    name: item.display_name,
    originalDescription: item.original_description,
    originalName: item.runtime_name,
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
  const payload = result.payload;
  // P1-10：抽屉标题展示别名（display_name），原名（runtime_name）单独展示；
  // 未设置别名（与原名同值）时如实省略别名。
  const aliased = payload.display_name !== payload.runtime_name;
  const row: SkillTableRow = {
    aiCheck: "not_run",
    agentDeploymentCount: 0,
    alias: aliased ? payload.display_name : undefined,
    basicCheck: "not_run",
    currentVersion: "unknown",
    highRiskCount: 0,
    id: payload.skill_id,
    lifecycle: "active",
    name: payload.display_name,
    originalName: payload.runtime_name,
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
// M-21 根因修复：后端 get_ui_preference 对未存储的键返回空 value_json——
// 这是“默认缺失”的正常首开状态，必须解析为 null（调用方回退默认值），
// 不得转换为读取失败；只有 IPC 失败或结果形状不符才是真读取失败。
async function readUiPreference(key: string): Promise<string | null> {
  let result: AppQueryResult;
  try {
    result = await queryApplication({ type: "get_ui_preference", payload: { key } });
  } catch {
    throw unavailableResult();
  }
  if (result.type !== "ui_preference") throw unavailableResult();
  if (!result.payload.value_json) return null;
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
  async loadViewMode() {
    const raw = await readUiPreference("library_view_mode");
    return raw === "cards" || raw === "matrix" ? raw : "cards";
  },
  async saveViewMode(mode) {
    await executeCommand({
      type: "set_ui_preference",
      payload: { key: "library_view_mode", value_json: JSON.stringify(mode) },
    });
  },
  async listDeployments() {
    const result = await queryApplication({ type: "list_deployments", payload: { skill_id: null } });
    if (result.type !== "deployments") throw unavailableResult();
    return result.payload;
  },
  async listDeploymentTargets() {
    const result = await queryApplication({ type: "list_deployment_targets", payload: null });
    if (result.type !== "deployment_targets") throw unavailableResult();
    return result.payload;
  },
  async loadGroupMode() {
    const raw = await readUiPreference("library_group_mode");
    return raw === "tags" ? "tags" : "none";
  },
  async saveGroupMode(mode) {
    await executeCommand({
      type: "set_ui_preference",
      payload: { key: "library_group_mode", value_json: JSON.stringify(mode) },
    });
  },
  // M-21：未存储（null）时解析为 null，页面静默回退 DEFAULT_TABLE_PREFERENCES；
  // 仅真实读取失败仍抛 unavailable，由页面显示可读错误。
  async loadTablePreferences() {
    const raw = await readUiPreference("table_preferences");
    return raw === null ? null : JSON.parse(raw) as SkillTablePreferences;
  },
  async saveTablePreferences(preferences) {
    await executeCommand({
      type: "set_ui_preference",
      payload: { key: "table_preferences", value_json: JSON.stringify(preferences) },
    });
  },
  async loadDrawerPreferences() {
    const raw = await readUiPreference("drawer_preferences");
    return raw === null ? null : JSON.parse(raw) as SkillDrawerPreferences;
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
      // QA-007：显示别名就是目录里的 display_name，抽屉编辑前需要真实现值。
      // 用真实读模型填充抽屉各模块（FE-05）：身份/版本/检查/部署关系。
      // QA-010：当前版本展示后端推导的可读标签；内容哈希只是技术身份，
      // 仍用于检查查询等需要精确版本身份的场合。
      view.currentVersion = skill.current_version_label ?? "unknown";
      // QA-008：用途显示用户独立撰写的字段，不用译文或原文冒充。
      view.purpose = skill.user_purpose ?? "";
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
      try {
        // N12：确定性重复读模型——当前版本内容哈希相同的其他 Skill。
        const duplicates = await queryApplication({
          type: "list_deterministic_duplicates",
          payload: { skill_id: skillId },
        });
        if (duplicates.type === "deterministic_duplicates") {
          view.duplicateCandidates = duplicates.payload.map((entry) => entry.label);
        }
      } catch {
        // 读取失败保持空列表，不在抽屉里伪造重复候选。
      }
      return view;
    } catch (error) {
      if (error instanceof SkillLibraryUnavailableError) throw error;
      throw unavailableResult();
    }
  },

  // QA-007：抽屉别名/备注/标签通过 set_metadata 持久化；该命令是整体覆盖，
  // 必须先读取当前值合并补丁，避免丢失作者或许可证。
  // P1-10 红线：display_name 只取补丁别名或回退 runtime_name，
  // 原名在任何路径下都不会被该命令修改（改名只能走 rename_skill，此处不使用）。
  async saveSkillMetadata(skillId, patch) {
    const result = await queryApplication({
      type: "get_skill",
      payload: { skill_id: skillId },
    });
    if (result.type !== "skill") throw unavailableResult();
    const skill = result.payload;
    const commandResult = await executeCommand({
      type: "set_metadata",
      payload: {
        skill_id: skillId,
        display_name: patch.alias === undefined
          ? skill.display_name
          : patch.alias?.trim() || skill.runtime_name,
        note: patch.note === undefined ? skill.user_note : patch.note || null,
        tags: patch.tags === undefined ? skill.tags : patch.tags,
        author: skill.author,
        license: skill.license,
        user_purpose: skill.user_purpose,
      },
    });
    if (commandResult.type !== "operation_summary") throw unavailableResult();
  },

  // FE-04 组合视图：读写组合目录；导出走标准导出（缺省格式由偏好决定）。
  async listCombinations() {
    const result = await queryApplication({ type: "list_combinations", payload: null });
    if (result.type !== "combinations") throw unavailableResult();
    return result.payload;
  },
  async createCombination(name, members) {
    await executeCommand({ type: "create_combination", payload: { name, members } });
  },
  async updateCombination(name, members) {
    await executeCommand({ type: "update_combination", payload: { name, members } });
  },
  // P1-09 组合重命名：RenameCombination 成功返回更新后的组合视图（无 message_code，
  // 成功提示由面板本地文案承担）；其余结果形状一律视为契约不可用。
  async renameCombination(fromName, toName) {
    const result = await executeCommand({
      type: "rename_combination",
      payload: { from: fromName, to: toName },
    });
    if (result.type !== "combination") throw unavailableResult();
    return result.payload;
  },
  async deleteCombination(name) {
    await executeCommand({ type: "delete_combination", payload: { name } });
  },
  async exportCombination(name) {
    // 敏感内容组合导出会被后端以 decision-required 诚实拒绝，由面板展示错误。
    const export_ = await executeCommand({
      type: "create_standard_export",
      payload: { input: { selection: { combination: name }, versions: "current", skills: [] }, decisions: [] },
    });
    if (export_.type !== "export_result") throw unavailableResult();
    return { path: export_.payload.path };
  },

  // N8 批量来源更新检查：单条失败由后端按项降级为 source_unavailable。
  async checkSourceUpdates(skillIds) {
    try {
      const result = await queryApplication({
        type: "check_source_updates",
        payload: { skill_ids: skillIds },
      });
      if (result.type !== "source_update_checks") throw unavailableResult();
      return result.payload.map((outcome) => ({
        skillId: outcome.skill_id,
        state: outcome.state,
      }));
    } catch (error) {
      if (error instanceof SkillLibraryUnavailableError) throw error;
      throw unavailableResult();
    }
  },
};
