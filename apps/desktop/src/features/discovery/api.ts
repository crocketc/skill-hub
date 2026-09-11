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
  type RepoDiscoveryReport,
  type ScanResult,
  type SkillRepo,
  type SourceSearchPage,
  type SourceSearchQuery,
} from "../../api/bindings";

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
  listSkillRepos: () => Promise<SkillRepo[]>;
  discoverRepoSkills: () => Promise<RepoDiscoveryReport>;
  discoverAgentsLockSkills: () => Promise<AgentsLockEntry[]>;
  addSkillRepo: (repo: SkillRepo) => Promise<SkillRepo[]>;
  removeSkillRepo: (owner: string, name: string) => Promise<SkillRepo[]>;
  downloadRepoSkill: (skill: DiscoverableRepoSkill) => Promise<DownloadedRepoSkill>;
  /** Opens a repository README link in the platform browser via the native shell. */
  openExternalUrl: (url: string) => Promise<void>;
  /**
   * P1-06：为目录创建忽略规则（安全排除）。只影响 SkillHub 的扫描与发现
   * 记录，绝不触碰目录中的用户文件；可通过既有忽略规则管理撤销。
   */
  createIgnoreRule: (path: string) => Promise<void>;
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
};

export interface FormatObservedAtOptions {
  locale?: string;
  timeZone?: string;
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
  /** 目录证据：任一 logical target available 即视为可用。 */
  available: boolean;
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
 * - 聚合卡片类型取组内去重后的 kind 集合；
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
  const clientIds = new Set(instanceKindByClient.keys());

  interface PhysicalAccumulator {
    physicalId: string;
    path: string;
    kinds: ClientKind[];
    available: boolean;
  }
  const byBrand = new Map<string, Map<string, PhysicalAccumulator>>();
  for (const target of snapshot.logical_targets as LogicalTarget[]) {
    if (!clientIds.has(target.client_id)) continue;
    const kind = instanceKindByClient.get(target.client_id);
    if (!kind) continue;
    let brandGroups = byBrand.get(target.profile_id);
    if (!brandGroups) {
      brandGroups = new Map();
      byBrand.set(target.profile_id, brandGroups);
    }
    let card = brandGroups.get(target.physical_id);
    if (!card) {
      card = { physicalId: target.physical_id, path: target.path, kinds: [], available: false };
      brandGroups.set(target.physical_id, card);
    }
    if (!card.kinds.includes(kind)) card.kinds.push(kind);
    card.available = card.available || target.available;
  }

  const groups: AgentBrandGroup[] = [];
  for (const [brand, cards] of byBrand) {
    const ordered = [...cards.values()]
      .map((card) => ({ ...card, kinds: [...card.kinds] }))
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
