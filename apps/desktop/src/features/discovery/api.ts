import {
  executeCommand,
  queryApplication,
  type AgentsLockEntry,
  type ClientInstance,
  type ClientKind,
  type DiscoverableRepoSkill,
  type DiscoverySnapshot,
  type DownloadedRepoSkill,
  type LogicalTarget,
  type OperationSummary,
  type RepoDiscoveryReport,
  type ScanResult,
  type SearchCandidateRecord,
  type SearchCandidateStatus,
  type SkillRepo,
  type SkillRepoView,
  type SourceSearchPage,
  type SourceSearchQuery,
} from "../../api/bindings";
import { nativeErrorCode, nativeErrorParams } from "../../api/nativeErrors";

/**
 * Contracts reused verbatim from the Rust ApplicationFacade:
 * - `get_discovery_snapshot` (query) -> discovery_snapshot
 * - `scan_targets` (command) -> scan_result
 * - `search_online_sources` (query) -> source_search_page
 */
export interface DiscoveryFacade {
  getDiscoverySnapshot: () => Promise<DiscoverySnapshot>;
  scanTargets: (scopeIds: string[]) => Promise<ScanResult>;
  searchOnlineSources: (query: SourceSearchQuery) => Promise<SourceSearchPage>;
  /** Optional AI query extension (US-014): the original query always runs
   * against the real provider; the AI layer only extends and marks hits.
   * Absent keeps the plain search behaviour. */
  searchOnlineSourcesAssisted?: (text: string) => Promise<SourceSearchPage>;
  /** 仓库列表（含每仓最近一次扫描状态；D4 仓库管理）。 */
  listSkillRepos: () => Promise<SkillRepoView[]>;
  discoverRepoSkills: () => Promise<RepoDiscoveryReport>;
  discoverAgentsLockSkills: () => Promise<AgentsLockEntry[]>;
  addSkillRepo: (repo: SkillRepo) => Promise<SkillRepoView[]>;
  removeSkillRepo: (owner: string, name: string) => Promise<SkillRepoView[]>;
  /**
   * D4 逐仓刷新（联网）：重扫单个已配置仓库并持久化其最近一次扫描状态；
   * 返回该仓库自己的发现报告。缺省表示当前环境不支持（如实降级）。
   */
  refreshSkillRepo?: (owner: string, name: string) => Promise<RepoDiscoveryReport>;
  downloadRepoSkill: (skill: DiscoverableRepoSkill) => Promise<DownloadedRepoSkill>;
  /** Opens a repository README link in the platform browser via the native shell. */
  openExternalUrl: (url: string) => Promise<void>;
  /**
   * P1-06：为目录创建忽略规则（安全排除）。只影响 SkillHub 的扫描与发现
   * 记录，绝不触碰目录中的用户文件；可通过既有忽略规则管理撤销。
   */
  createIgnoreRule: (path: string) => Promise<void>;
  /**
   * P1-05：搜索候选确认闭环（四个能力都可选；任一缺失时结果卡如实隐藏
   * 登记/忽略动作，不渲染无效按钮）。候选确认只登记导入意向，成为来源
   * 仍然只有导入向导提交这一条路。
   */
  /** 列出全部持久化候选（跨会话恢复，用于结果行状态徽标初始化）。 */
  listSearchCandidates?: () => Promise<SearchCandidateRecord[]>;
  /** 把一次搜索结果页落为候选；返回后端归并后的全量候选列表。 */
  saveSearchCandidates?: (page: SourceSearchPage) => Promise<SearchCandidateRecord[]>;
  /** pending/confirmed → confirmed（幂等）；dismissed → confirmed 被原生层拒绝。 */
  confirmSearchCandidate?: (candidateId: string) => Promise<OperationSummary>;
  /** 任意非 dismissed 状态 → dismissed；dismissed → dismissed 幂等成功。 */
  dismissSearchCandidate?: (candidateId: string) => Promise<OperationSummary>;
}

export const desktopDiscoveryFacade: DiscoveryFacade = {
  async getDiscoverySnapshot() {
    const result = await queryApplication({
      type: "get_discovery_snapshot",
      payload: null,
    });
    if (result.type !== "discovery_snapshot") {
      throw new Error("Unexpected discovery snapshot response from the native application.");
    }
    return result.payload;
  },
  async scanTargets(scopeIds) {
    const result = await executeCommand({
      type: "scan_targets",
      payload: { scope_ids: scopeIds },
    });
    if (result.type !== "scan_result") {
      throw new Error("Unexpected scan result response from the native application.");
    }
    return result.payload;
  },
  async searchOnlineSources(query) {
    const result = await queryApplication({
      type: "search_online_sources",
      payload: { query },
    });
    if (result.type !== "source_search_page") {
      throw new Error("Unexpected source search response from the native application.");
    }
    return result.payload;
  },
  async searchOnlineSourcesAssisted(text) {
    const result = await queryApplication({
      type: "search_online_sources_assisted",
      payload: { text },
    });
    if (result.type !== "source_search_page") {
      throw new Error("Unexpected assisted source search response from the native application.");
    }
    return result.payload;
  },
  async listSkillRepos() {
    const result = await queryApplication({ type: "list_skill_repos", payload: null });
    if (result.type !== "skill_repos") {
      throw new Error("Unexpected skill repos response from the native application.");
    }
    return result.payload;
  },
  async discoverRepoSkills() {
    const result = await queryApplication({ type: "discover_repo_skills", payload: null });
    if (result.type !== "repo_discovery_report") {
      throw new Error("Unexpected repo discovery response from the native application.");
    }
    return result.payload;
  },
  async discoverAgentsLockSkills() {
    const result = await queryApplication({ type: "discover_agents_lock_skills", payload: null });
    if (result.type !== "agents_lock_entries") {
      throw new Error("Unexpected agents lock response from the native application.");
    }
    return result.payload;
  },
  async addSkillRepo(repo) {
    const result = await executeCommand({ type: "add_skill_repo", payload: { repo } });
    if (result.type !== "skill_repos") {
      throw new Error("Unexpected skill repos response from the native application.");
    }
    return result.payload;
  },
  async removeSkillRepo(owner, name) {
    const result = await executeCommand({
      type: "remove_skill_repo",
      payload: { owner, name },
    });
    if (result.type !== "skill_repos") {
      throw new Error("Unexpected skill repos response from the native application.");
    }
    return result.payload;
  },
  async refreshSkillRepo(owner, name) {
    const result = await executeCommand({
      type: "refresh_skill_repo",
      payload: { owner, name },
    });
    if (result.type !== "repo_discovery_report") {
      throw new Error("Unexpected repo refresh response from the native application.");
    }
    return result.payload;
  },
  async downloadRepoSkill(skill) {
    const result = await executeCommand({
      type: "download_repo_skill",
      payload: { skill },
    });
    if (result.type !== "downloaded_repo_skill") {
      throw new Error("Unexpected downloaded repo skill response from the native application.");
    }
    return result.payload;
  },
  async openExternalUrl(url: string) {
    const result = await executeCommand({
      type: "open_external_url",
      payload: { url },
    });
    if (result.type !== "operation_summary") {
      throw new Error("Unexpected external link response from the native application.");
    }
  },
  async createIgnoreRule(path: string) {
    const result = await executeCommand({
      type: "create_ignore_rule",
      payload: {
        subject: { type: "exact_path", value: path },
        reason: "discovery-exclude",
        defer_until: null,
      },
    });
    if (result.type !== "ignore_rule") {
      throw new Error("Unexpected ignore rule response from the native application.");
    }
  },
  async listSearchCandidates() {
    const result = await queryApplication({ type: "list_search_candidates", payload: null });
    if (result.type !== "search_candidates") {
      throw new Error("Unexpected search candidates response from the native application.");
    }
    return result.payload;
  },
  async saveSearchCandidates(page) {
    const result = await executeCommand({
      type: "save_search_candidates",
      payload: { page },
    });
    if (result.type !== "search_candidates") {
      throw new Error("Unexpected saved search candidates response from the native application.");
    }
    return result.payload;
  },
  async confirmSearchCandidate(candidateId) {
    const result = await executeCommand({
      type: "confirm_search_candidate",
      payload: { candidate_id: candidateId },
    });
    if (result.type !== "operation_summary") {
      throw new Error("Unexpected candidate confirmation response from the native application.");
    }
    return result.payload;
  },
  async dismissSearchCandidate(candidateId) {
    const result = await executeCommand({
      type: "dismiss_search_candidate",
      payload: { candidate_id: candidateId },
    });
    if (result.type !== "operation_summary") {
      throw new Error("Unexpected candidate dismissal response from the native application.");
    }
    return result.payload;
  },
};

export interface FormatObservedAtOptions {
  locale?: string;
  timeZone?: string;
}

/**
 * P1-04：把后端逐仓失败原因（原始错误串）映射为可读分类文案；
 * 已知分类不再展示原始串，未分类原因保留原始串方便诊断，绝不静默。
 * 仓库发现页与 D4 仓库管理页共用同一映射，失败叙事保持一致。
 */
export function describeRepoWarning(
  reason: string,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  const normalized = reason.toUpperCase();
  if (normalized.includes("404") || normalized.includes("NOT_FOUND")) {
    return translate("discovery.repo.warningReason.notFound");
  }
  if (normalized.includes("TIMEOUT")) {
    return translate("discovery.repo.warningReason.timeout");
  }
  if (normalized.includes("NETWORK")) {
    return translate("discovery.repo.warningReason.network");
  }
  return translate("discovery.repo.warningReason.unknown", { reason });
}

/**
 * P1-05：结果行需要追踪的候选切片。candidate id 由后端按
 * provider+provider_source_id 派生（sha256），前端不重算、只透传；
 * 归并键用 provider_source_id（即 SourceSearchHit.source_id）。
 */
export interface CandidateEntry {
  id: string;
  status: SearchCandidateStatus;
}

/**
 * 把后端返回的候选记录归并进既有索引（key = provider_source_id），
 * 总是产生新 Map，不改写入参。save_search_candidates 返回全量列表，
 * 直接整体合并即可拿到与本页命中对应的最新状态。
 */
export function mergeCandidateEntries(
  prev: Map<string, CandidateEntry>,
  records: SearchCandidateRecord[],
): Map<string, CandidateEntry> {
  const next = new Map(prev);
  for (const record of records) {
    next.set(record.provider_source_id, { id: record.id, status: record.status });
  }
  return next;
}

/**
 * P1-05：识别“已忽略的候选不能再次确认”的原生冲突
 * （operation.conflict + params.reason=candidate_dismissed）。该冲突在
 * keyedMessage 中没有专属映射，必须在 describeNativeError 之前拦截，
 * 否则用户会看到裸错误码。
 */
export function isCandidateDismissedConflict(reason: unknown): boolean {
  return nativeErrorCode(reason) === "operation.conflict"
    && nativeErrorParams(reason).reason === "candidate_dismissed";
}

/**
 * P1-04：解析发现快照的 observed_at。兼容三种历史形态：ISO 字符串、
 * 后端 `now()` 产出的 epoch 秒十进制字符串（旧库快照）、以及 epoch
 * 秒/毫秒 number（ScanGeneration.observed_at）。解析失败返回 null，
 * 由调用方给出明确占位，绝不露出原始串。
 */
export function parseObservedAt(input: string | number): Date | null {
  const trimmed = typeof input === "string" ? input.trim() : input;
  if (trimmed === "") return null;
  let date: Date;
  if (typeof trimmed === "number") {
    // >= 1e12 视为毫秒，否则视为秒（后端 epoch 秒语义）。
    date = new Date(Math.abs(trimmed) >= 1e12 ? trimmed : trimmed * 1000);
  } else if (/^-?\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) return null;
    date = new Date(Math.abs(seconds) >= 1e12 ? seconds : seconds * 1000);
  } else {
    date = new Date(trimmed);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 把 observed_at 渲染为本地化日期时间；不可解析时返回 null。 */
export function formatObservedAt(
  input: string | number,
  options: FormatObservedAtOptions = {},
): string | null {
  const date = parseObservedAt(input);
  if (!date) return null;
  try {
    return new Intl.DateTimeFormat(options.locale || undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(date);
  } catch {
    // 非法 locale/timeZone 不应让页面崩溃：回退默认环境格式。
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }
}

/** D4：解析后的仓库坐标（branch 为空串 = 走仓库默认分支哨兵）。 */
export interface ParsedRepoInput {
  owner: string;
  name: string;
  branch: string;
}

const REPO_OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * D4：把用户输入解析为仓库坐标。接受四种形态——owner/name、完整
 * GitHub URL、.git 后缀、/tree/branch 子路径——其余（含非法字符、
 * 非 GitHub 主机、越权分支段）返回 null，由调用方给出行内提示，
 * 不把坏坐标提交给后端。规则与后端 repo_ref 校验同口径。
 */
export function parseRepoInput(input: string): ParsedRepoInput | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  let segments: string[];
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) return null;
    segments = url.pathname.split("/").filter(Boolean);
  } else {
    segments = trimmed.split("/").filter(Boolean);
  }

  if (segments.length < 2) return null;
  const [owner, rawName] = segments;
  const rest = segments.slice(2);
  let branch = "";
  if (rest.length > 0) {
    // /tree/branch 子路径：余下段整体作为分支（保留 feature/x 形态）。
    if (rest[0].toLowerCase() !== "tree" || rest.length < 2) return null;
    branch = rest.slice(1).join("/");
  }
  const name = rawName.replace(/\.git$/i, "");

  if (!REPO_OWNER_PATTERN.test(owner)) return null;
  if (!REPO_NAME_PATTERN.test(name) || name === "." || name === "..") return null;
  if (branch !== "" && !isValidBranchName(branch)) return null;
  return { owner, name, branch };
}

/** 与后端 repo_ref.is_valid_git_branch 同规则：段不得为空/./..、
 * 不得以 '.' 开头、不得以 .lock 结尾；空串与 HEAD 是默认分支哨兵。 */
function isValidBranchName(branch: string): boolean {
  if (branch.length > 255) return false;
  return branch.split("/").every(
    (segment) =>
      segment !== ""
      && segment !== "."
      && segment !== ".."
      && !segment.startsWith(".")
      && !segment.endsWith(".lock")
      && BRANCH_SEGMENT_PATTERN.test(segment),
  );
}

export interface FormatRelativeScanTimeOptions {
  locale?: string;
  timeZone?: string;
  /** 注入当前时刻（测试确定性）；缺省取真实 now。 */
  now?: Date;
}

/**
 * D4：把上次扫描时间渲染为相对时间（近程）或本地化日期（远程）。
 * 前端只做展示换算，不承担任何边界校验职责；不可解析时返回 null。
 */
export function formatRelativeScanTime(
  scannedAt: string,
  options: FormatRelativeScanTimeOptions = {},
): string | null {
  const date = parseObservedAt(scannedAt);
  if (!date) return null;
  const now = options.now ?? new Date();
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  try {
    const relative = new Intl.RelativeTimeFormat(options.locale || undefined, {
      numeric: "auto",
    });
    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 1) return relative.format(seconds, "second");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 1) return relative.format(minutes, "minute");
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 31) return relative.format(hours, "hour");
  } catch {
    // 相对格式化不可用时回退本地化日期，绝不抛错中断页面。
  }
  try {
    return new Intl.DateTimeFormat(options.locale || undefined, {
      dateStyle: "medium",
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
  }
}

export interface ScanClassification {
  /** Skills found on scanned roots that are not yet managed in the library. */
  unmanaged: number;
  /** Logical targets that exist, are readable/writable, and are linked. */
  related: number;
  /** Logical targets that exist but are not currently available. */
  conflict: number;
  /** Discovered skills sharing the same fingerprint (suspected duplicates). */
  suspected: number;
  /** Paths that failed to scan. */
  unreadable: number;
}

/**
 * Derives the five-category classification from the discovery snapshot and
 * the latest scan result. Pure function so tests can pin the behavior.
 */
export function classifyScan(
  snapshot: DiscoverySnapshot,
  result: ScanResult,
): ScanClassification {
  const related = snapshot.logical_targets.filter(
    (target) => target.exists && target.readable && target.writable && target.available,
  ).length;
  const conflict = snapshot.logical_targets.filter(
    (target) => target.exists && !(target.readable && target.writable && target.available),
  ).length;
  const fingerprints = new Set<string>();
  let suspected = 0;
  for (const skill of result.discovered) {
    if (fingerprints.has(skill.fingerprint)) suspected += 1;
    else fingerprints.add(skill.fingerprint);
  }
  return {
    unmanaged: result.discovered.length,
    related,
    conflict,
    suspected,
    unreadable: result.errors.length,
  };
}

/** P1-06：一张聚合后的 Agent 目录卡片（同 physical 目录合并展示）。 */
export interface AgentTargetCard {
  physicalId: string;
  /** 该 physical 组内任一 target 的路径（同一 physical 路径等价）。 */
  path: string;
  /** 组内去重后的客户端类型（如 desktop+cli → "桌面端/CLI"）。 */
  kinds: ClientKind[];
  /** OPT-07：组内客户端的官方产品名（逐客户端核验，去重、按出现顺序）。 */
  names: string[];
  /** 目录证据：任一 logical target available 即视为可用。 */
  available: boolean;
  /**
   * OPT-07：同一物理目录上共享引用（shared_reference）的已登记客户端数。
   * 共享引用保留品牌侧可用性，但归属卡片只由通用 Agent 目录产出一次。
   */
  sharedClients: number;
  /** OPT-07：共享引用客户端的官方产品名（提示与诊断用）。 */
  sharedClientNames: string[];
}

/** P1-06：一个品牌（profile）的分组；组内可用卡片在前、不可用置底。 */
export interface AgentBrandGroup {
  brand: string;
  available: boolean;
  cards: AgentTargetCard[];
}

export interface AgentGroups {
  available: AgentBrandGroup[];
  unavailable: AgentBrandGroup[];
}

const byBrandName = (a: AgentBrandGroup, b: AgentBrandGroup) =>
  a.brand.localeCompare(b.brand);

/**
 * P1-06：从发现快照构建 Agent 分组视图。
 * - 先按当前 OS 过滤 profile 声明的 supported_os（空列表视为未声明，保留）；
 * - 按品牌（profile_id）分组，组内按 physical_id 聚合（后端已把同目录
 *   的不同客户端归并为同一 physical_id）；
 * - 聚合卡片类型取组内去重后的 kind 集合，官方产品名随卡片并列展示；
 * - OPT-07：shared_reference 目标（`.agents/skills` 跨品牌共享引用）不再
 *   产出品牌卡片，而是把引用计数与客户端名聚合到同一物理目录的通用
 *   归属卡片上——归属只出现一次，品牌侧可用性不回退；
 * - 可用品牌在前（按品牌名排序），完全不可用的品牌整体置底。
 */
export function buildAgentGroups(
  snapshot: DiscoverySnapshot,
  options: { os: "windows" | "macos" },
): AgentGroups {
  const osInstances = snapshot.instances.filter(
    (instance: ClientInstance) =>
      instance.supported_os.length === 0 || instance.supported_os.includes(options.os),
  );
  const instanceKindByClient = new Map(
    osInstances.map((instance) => [instance.client_id, instance.kind]),
  );
  const instanceNameByClient = new Map(
    osInstances.map((instance) => [instance.client_id, instance.display_name || instance.client_id]),
  );
  const clientIds = new Set(instanceKindByClient.keys());

  interface PhysicalAccumulator {
    physicalId: string;
    path: string;
    kinds: ClientKind[];
    names: string[];
    available: boolean;
  }
  const byBrand = new Map<string, Map<string, PhysicalAccumulator>>();
  const sharedByPhysical = new Map<
    string,
    { available: boolean; clientIds: string[]; names: string[]; path: string }
  >();
  for (const target of snapshot.logical_targets as LogicalTarget[]) {
    if (!clientIds.has(target.client_id)) continue;
    const kind = instanceKindByClient.get(target.client_id);
    if (!kind) continue;
    const clientName = instanceNameByClient.get(target.client_id) ?? target.client_id;
    if (target.shared_reference) {
      // OPT-07：共享引用不产出归属卡片，聚合到通用目录卡片上。
      let shared = sharedByPhysical.get(target.physical_id);
      if (!shared) {
        shared = { available: false, clientIds: [], names: [], path: target.path };
        sharedByPhysical.set(target.physical_id, shared);
      }
      shared.available = shared.available || target.available;
      if (!shared.clientIds.includes(target.client_id)) shared.clientIds.push(target.client_id);
      if (!shared.names.includes(clientName)) shared.names.push(clientName);
      continue;
    }
    let brandGroups = byBrand.get(target.profile_id);
    if (!brandGroups) {
      brandGroups = new Map();
      byBrand.set(target.profile_id, brandGroups);
    }
    let card = brandGroups.get(target.physical_id);
    if (!card) {
      card = {
        physicalId: target.physical_id,
        path: target.path,
        kinds: [],
        names: [],
        available: false,
      };
      brandGroups.set(target.physical_id, card);
    }
    if (!card.kinds.includes(kind)) card.kinds.push(kind);
    const name = instanceNameByClient.get(target.client_id);
    if (name && !card.names.includes(name)) card.names.push(name);
    card.available = card.available || target.available;
  }

  // A snapshot can contain only brand-specific references when the generic
  // shared-directory profile was not registered. The physical shared
  // directory is still one independent user-facing entity.
  const genericCards = byBrand.get("agent-skills") ?? new Map<string, PhysicalAccumulator>();
  for (const [physicalId, shared] of sharedByPhysical) {
    const existing = genericCards.get(physicalId);
    if (existing) {
      existing.available = existing.available || shared.available;
      continue;
    }
    genericCards.set(physicalId, {
      physicalId,
      path: shared.path,
      kinds: ["shared_directory"],
      names: ["Agent Skills"],
      available: shared.available,
    });
  }
  if (genericCards.size > 0) byBrand.set("agent-skills", genericCards);

  const groups: AgentBrandGroup[] = [];
  for (const [brand, cards] of byBrand) {
    const ordered = [...cards.values()]
      .map((card) => {
        const shared = sharedByPhysical.get(card.physicalId);
        return {
          ...card,
          kinds: [...card.kinds],
          names: [...card.names],
          sharedClients: shared?.clientIds.length ?? 0,
          sharedClientNames: shared ? [...shared.names] : [],
        };
      })
      .sort((a, b) => Number(b.available) - Number(a.available) || a.path.localeCompare(b.path));
    groups.push({
      brand,
      available: ordered.some((card) => card.available),
      cards: ordered,
    });
  }
  const sorted = [...groups].sort(byBrandName);
  return {
    available: sorted.filter((group) => group.available),
    unavailable: sorted.filter((group) => !group.available),
  };
}
