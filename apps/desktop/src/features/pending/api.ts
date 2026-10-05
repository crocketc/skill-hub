export type PendingKind = "trial_due" | "security_finding" | "security_alert" | "recovery" | "conflict" | "governance" | "governance_followup" | "basic_check" | "import_skills" | "ai_setup" | "backup_setup" | "source_update" | "agent_compatibility";
export type PendingRisk = "high" | "medium" | "low";
export type PendingItem = {
  agentBrand?: string;
  agentKinds?: import("../../ui/AgentPresentation").AgentKindKey[];
  /** Local projection metadata. Identity values are never rendered. */
  agentDirectoryKey?: string;
  agentSharedDirectory?: boolean;
  agentSharedBrands?: string[];
  agentSharedBrandKinds?: Record<string, import("../../ui/AgentPresentation").AgentKindKey[]>;
  id: string;
  subject: string;
  kind: PendingKind;
  code: string;
  message: string;
  /** Readable object name; identifiers stay in subject/id only. */
  displayName?: string | null;
  href?: string;
  path?: string;
  /** Required decisions and recovery must be resolved at their source. */
  canSnooze?: boolean;
  recommended?: boolean;
  versionId?: string;
  findingId?: string;
  checkKind?: string;
  sourceRoots?: string[];
  canConfirm?: boolean;
  /** 试用到期日（YYYY-MM-DD），仅试用项携带。 */
  dueDate?: string | null;
  /** 风险档位，由检查发现严重级别映射；无数据时缺省。 */
  risk?: PendingRisk | null;
  /** 影响面：该 Skill 当前生效的部署关系数量；无法计算时缺省。 */
  affectedDeployments?: number | null;
};
/** 处理历史中的一条暂缓/忽略记录（原生忽略规则的 exact_pending 子集）。 */
export type HandledEntry = {
  id: string;
  pendingId: string;
  displayName?: string | null;
  reason: string;
  createdAt: string;
  deferUntil: string | null;
  confirmed?: boolean;
};
export interface PendingFacade {
  recordCompatibility?(request: import("../../api/bindings").RecordAgentCompatibility): Promise<void>;
  list(): Promise<PendingItem[]>;
  workspace?(): Promise<{ items: PendingItem[]; unavailableSources: string[] }>;
  confirm?(item: PendingItem, reason: string): Promise<void>;
  resolve(item: PendingItem): Promise<void>;
  recheck(item: PendingItem): Promise<void>;
  convert(item: PendingItem): Promise<void>;
  remove(item: PendingItem): Promise<void>;
  recover(item: PendingItem): Promise<void>;
  /** 逐条创建暂缓忽略规则（defer_until = 今天 + days 的本地 YYYY-MM-DD）。 */
  defer(items: PendingItem[], days: number, reason: string): Promise<void>;
  /** 逐条创建永久忽略规则（defer_until = null）。 */
  ignore(items: PendingItem[], reason: string): Promise<void>;
  /** 列出针对待处理事项的暂缓/忽略规则。 */
  listHandled(): Promise<HandledEntry[]>;
  /** 撤销一条暂缓/忽略规则。 */
  unignore(ruleId: string): Promise<void>;
  /** 读取上次保存的类型筛选视图；键缺失或解析失败时返回 null。 */
  loadSavedView(): Promise<string | null>;
  /** 持久化类型筛选视图（ui_preference，JSON 字符串）。 */
  saveSavedView(kind: string): Promise<void>;
}
const unavailable = (operation: string): Promise<never> => Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));
export const unavailablePendingFacade: PendingFacade = {
  list: () => unavailable("pending_list"),
  resolve: () => unavailable("pending_resolve"),
  recheck: () => unavailable("pending_recheck"),
  convert: () => unavailable("pending_convert"),
  remove: () => unavailable("pending_remove"),
  recover: () => unavailable("pending_recover"),
  defer: () => unavailable("create_ignore_rule"),
  ignore: () => unavailable("create_ignore_rule"),
  listHandled: () => unavailable("list_ignore_rules"),
  unignore: () => unavailable("remove_ignore_rule"),
  loadSavedView: () => unavailable("get_ui_preference"),
  saveSavedView: () => unavailable("set_ui_preference"),
};
