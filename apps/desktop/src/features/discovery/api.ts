import {
  executeCommand,
  queryApplication,
  type AgentDirectoryProjection,
  type ClientKind,
  type DiscoverableRepoSkill,
  type DiscoverySnapshot,
  type DownloadedRepoSkill,
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
import { buildAgentDirectoryCardModels, type AgentCardModel } from "../agents/agentCardModel";
import { brandDisplayName } from "../../ui/BrandTag";

/**
 * Contracts reused verbatim from the Rust ApplicationFacade:
 * - `get_discovery_snapshot` (query) -> discovery_snapshot
 * - `scan_targets` (command) -> scan_result
 * - `search_online_sources` (query) -> source_search_page
 */
export interface DiscoveryFacade {
  getDiscoverySnapshot: () => Promise<DiscoverySnapshot>;
  getAgentDirectoryProjection?: () => Promise<AgentDirectoryProjection>;
  scanTargets: (scopeIds: string[]) => Promise<ScanResult>;
  searchOnlineSources: (query: SourceSearchQuery) => Promise<SourceSearchPage>;
  /** Optional AI query extension (US-014): the original query always runs
   * against the real provider; the AI layer only extends and marks hits.
   * Absent keeps the plain search behaviour. */
  searchOnlineSourcesAssisted?: (text: string) => Promise<SourceSearchPage>;
  /** 仓库列表（含每仓最近一次扫描状态；D4 仓库管理）。 */
  listSkillRepos: () => Promise<SkillRepoView[]>;
  discoverRepoSkills: () => Promise<RepoDiscoveryReport>;
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
  async getAgentDirectoryProjection() {
    const result = await queryApplication({ type: "get_agent_directory_projection", payload: null });
    if (result.type !== "agent_directory_projection") {
      throw new Error("Unexpected Agent directory projection response from the native application.");
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
  /** Canonical card identity from the shared Agent directory model. */
  physicalId: string;
  /** 该 physical 组内任一 target 的路径（同一 physical 路径等价）。 */
  path: string;
  /** 组内去重后的客户端类型（如 desktop+cli → "桌面端/终端"）。 */
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
  sharedBrands: string[];
  sharedBrandKinds: Record<string, string[]>;
  /**
   * 2026-09-25 验收裁决：内置技能目录（平台只读，如 `.codex/skills/.system`）
   * 独立成「内置」类型卡片；本机不存在的内置候选不出卡（平台自管，缺席非故障）。
   */
  builtin: boolean;
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
 * Discovery presentation adapter over the canonical directory card model.
 * It preserves the existing brand sections and availability ordering while
 * leaving card identity, membership, and shared-directory associations intact.
 */
export function buildAgentGroupsFromProjection(projection: AgentDirectoryProjection): AgentGroups {
  const models = buildAgentDirectoryCardModels(projection);
  const cardsByBrand = new Map<string, AgentTargetCard[]>();
  models.forEach((model: AgentCardModel, index) => {
    const directory = model.directories[0];
    const fact = projection.directories[index];
    if (directory?.role === "project") return;
    // Platform-managed builtin paths are optional. Their absence is normal and
    // stays quiet, matching the discovery inventory's previous behavior.
    if (model.builtin && !fact?.exists) return;
    const path = directory?.path ?? fact?.path ?? "";
    const available = Boolean(directory?.available);
    const sharedMembers = (model.directoryMembers ?? []).filter(
      (member) => !isGenericSharedOwner(member) && member.brand && member.client_id,
    );
    const names = model.sharedDirectory
      ? [...new Set(sharedMembers.flatMap((member) => member.brand ? [brandDisplayName(member.brand)] : []))]
      : [...new Set(model.members.map((member) => member.instance))];
    const sharedBrands = [...new Set(sharedMembers.flatMap((member) => member.brand ? [member.brand] : []))].sort();
    const sharedBrandKinds = Object.fromEntries(sharedBrands.map((brand) => [
      brand,
      [...new Set(sharedMembers.flatMap((member) => member.brand === brand && member.kind ? [member.kind] : []))].sort(),
    ]));
    const card: AgentTargetCard = {
      physicalId: model.id,
      path,
      kinds: model.kinds as ClientKind[],
      names,
      available,
      sharedClients: model.sharedDirectory
        ? new Set(sharedMembers.flatMap((member) => member.client_id ? [member.client_id] : [])).size
        : 0,
      sharedClientNames: model.sharedDirectory
        ? [...new Set(sharedMembers.flatMap((member) => member.brand ? [brandDisplayName(member.brand)] : []))]
        : [],
      sharedBrands,
      sharedBrandKinds,
      builtin: model.builtin,
    };
    const cards = cardsByBrand.get(model.brand) ?? [];
    cards.push(card);
    cardsByBrand.set(model.brand, cards);
  });
  const groups = [...cardsByBrand].map(([brand, cards]): AgentBrandGroup => {
    const ordered = cards.sort((a, b) =>
      Number(b.available) - Number(a.available) || a.path.localeCompare(b.path),
    );
    return { brand, available: ordered.some((card) => card.available), cards: ordered };
  });
  const sorted = groups.sort(byBrandName);
  return {
    available: sorted.filter((group) => group.available),
    unavailable: sorted.filter((group) => !group.available),
  };
}

function isGenericSharedOwner(member: { brand: string | null; client_id: string | null }): boolean {
  return member.brand === "agent-skills" || member.client_id === "agent-skills.shared-directory";
}

function snapshotInstanceLabel(
  target: DiscoverySnapshot["logical_targets"][number],
  instance: DiscoverySnapshot["instances"][number],
): string {
  return instance.display_name?.trim() || brandDisplayName(target.profile_id);
}

function snapshotProjection(
  snapshot: DiscoverySnapshot,
  os: "windows" | "macos",
): AgentDirectoryProjection {
  const instances = new Map(
    snapshot.instances
      .filter((instance) => instance.supported_os.length === 0 || instance.supported_os.includes(os))
      .map((instance) => [`${instance.profile_id}:${instance.client_id}`, instance]),
  );
  const normalizeSharedPath = (path: string) => {
    const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/g, "");
    return os === "windows" ? normalized.toLowerCase() : normalized;
  };
  const sharedPaths = new Set(snapshot.logical_targets.flatMap((target) => {
    const instance = instances.get(`${target.profile_id}:${target.client_id}`);
    return target.shared_reference || instance?.kind === "shared_directory" ? [normalizeSharedPath(target.path)] : [];
  }));
  const grouped = new Map<string, {
    role: AgentDirectoryProjection["directories"][number]["role"];
    identity: AgentDirectoryProjection["directories"][number]["identity"];
    path: string;
    targets: DiscoverySnapshot["logical_targets"];
  }>();
  for (const target of snapshot.logical_targets) {
    const instance = instances.get(`${target.profile_id}:${target.client_id}`);
    if (!instance || (target.builtin && !target.exists)) continue;
    const normalizedPath = normalizeSharedPath(target.path);
    const sharedPathMatch = sharedPaths.has(normalizedPath);
    const role = target.builtin
      ? "builtin"
      : target.scope === "project"
        ? "project"
        : target.shared_reference || instance.kind === "shared_directory" || sharedPathMatch
          ? "shared_directory"
          : "agent_native";
    const verified = target.physical_identity_verified !== false;
    const identity = sharedPathMatch
      ? { kind: "verified_physical" as const, value: `shared-path:${normalizedPath}` }
      : verified
      ? { kind: "verified_physical" as const, value: target.physical_id }
      : { kind: "candidate" as const, value: target.id };
    const key = `${role}:${identity.kind}:${identity.value}`;
    const group = grouped.get(key) ?? {
      role,
      identity,
      path: snapshot.physical_targets.find((physical) => physical.id === target.physical_id)?.path ?? target.path,
      targets: [],
    };
    group.targets.push(target);
    grouped.set(key, group);
  }
  return {
    directories: [...grouped.values()].map((group) => {
      const physical = snapshot.physical_targets.find((candidate) => candidate.id === group.targets[0]?.physical_id);
      const exists = physical?.exists ?? group.targets.some((target) => target.exists);
      const readable = physical?.readable ?? group.targets.some((target) => target.readable);
      const writable = physical?.writable ?? group.targets.some((target) => target.writable);
      const available = group.targets.some((target) => target.available);
      const status = group.targets.find((target) => target.status)?.status
        ?? (exists ? available ? "existing" : "inaccessible" : "missing");
      return {
        role: group.role,
        identity: group.identity,
        path: group.path,
        status,
        exists,
        readable,
        writable,
        available,
        members: group.targets.map((target) => {
          const instance = instances.get(`${target.profile_id}:${target.client_id}`)!;
          const memberAvailable = target.available && target.physical_identity_verified !== false;
          return {
            logical_target_id: target.id,
            brand: target.profile_id,
            client_id: target.client_id,
            kind: instance.kind,
            availability: {
              status: target.status ?? (target.exists ? memberAvailable ? "existing" : "inaccessible" : "missing"),
              exists: target.exists,
              readable: target.readable,
              writable: target.writable,
              available: memberAvailable,
            },
            capabilities: { deployment: { copy: false, symlink: false, junction: false }, modes: [], preferred_mode: null },
            deployment_status: "not_deployed" as const,
            managed_deployment_relation_count: 0,
            managed_deployment_count: 0,
          };
        }),
      };
    }),
  } as AgentDirectoryProjection;
}

/**
 * Keep the previous snapshot+OS call shape for unmigrated consumers. The
 * adapter converts those observed facts into the canonical projection, then
 * delegates card identity and presentation to the shared model.
 */
export function buildAgentGroups(projection: AgentDirectoryProjection): AgentGroups;
export function buildAgentGroups(snapshot: DiscoverySnapshot, options: { os: "windows" | "macos" }): AgentGroups;
export function buildAgentGroups(
  input: AgentDirectoryProjection | DiscoverySnapshot,
  options?: { os: "windows" | "macos" },
): AgentGroups {
  if ("directories" in input) return buildAgentGroupsFromProjection(input);

  const projection = snapshotProjection(input, options?.os ?? "windows");
  const groups = buildAgentGroupsFromProjection(projection);
  const modelsById = new Map(buildAgentDirectoryCardModels(projection).map((model) => [model.id, model]));
  const instances = new Map(input.instances.map((instance) => [`${instance.profile_id}:${instance.client_id}`, instance]));
  const targets = new Map(input.logical_targets.map((target) => [target.id, target]));
  for (const group of [...groups.available, ...groups.unavailable]) {
    for (const card of group.cards) {
      const model = modelsById.get(card.physicalId);
      if (!model) continue;
      const targetMembers = (model.directoryMembers ?? []).flatMap((member) => {
        const target = targets.get(member.logical_target_id);
        const instance = target ? instances.get(`${target.profile_id}:${target.client_id}`) : undefined;
        return target && instance ? [{ target, instance }] : [];
      });
      const shared = model.sharedDirectory;
      const visibleMembers = targetMembers.filter(({ target }) =>
        !shared || (target.profile_id !== "agent-skills" && target.client_id !== "agent-skills.shared-directory"),
      );
      group.brand = shared ? "agent-skills" : targetMembers[0]?.target.profile_id ?? group.brand;
      card.physicalId = targetMembers[0]?.target.physical_id
        ?? model.directories[0]?.candidateIdentityKey
        ?? card.physicalId;
      card.names = [...new Set(visibleMembers.map(({ target, instance }) => snapshotInstanceLabel(target, instance)))];
      if (shared) {
        card.sharedBrands = [...new Set(visibleMembers.map(({ target }) => target.profile_id))].sort();
        card.sharedBrandKinds = Object.fromEntries(card.sharedBrands.map((brand) => [
          brand,
          [...new Set(visibleMembers.flatMap(({ target, instance }) => target.profile_id === brand ? [instance.kind] : []))].sort(),
        ]));
        card.sharedClients = new Set(visibleMembers.map(({ target }) => target.client_id)).size;
        card.sharedClientNames = [...new Set(visibleMembers.map(({ target, instance }) => snapshotInstanceLabel(target, instance)))];
      }
    }
  }
  groups.available.sort((a, b) => a.brand.localeCompare(b.brand));
  groups.unavailable.sort((a, b) => a.brand.localeCompare(b.brand));
  return groups;
}
