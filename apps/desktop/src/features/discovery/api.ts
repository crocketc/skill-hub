import {
  executeCommand,
  queryApplication,
  type DiscoverableRepoSkill,
  type DiscoverySnapshot,
  type DownloadedRepoSkill,
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
  listSkillRepos: () => Promise<SkillRepo[]>;
  discoverRepoSkills: () => Promise<RepoDiscoveryReport>;
  addSkillRepo: (repo: SkillRepo) => Promise<SkillRepo[]>;
  removeSkillRepo: (owner: string, name: string) => Promise<SkillRepo[]>;
  downloadRepoSkill: (skill: DiscoverableRepoSkill) => Promise<DownloadedRepoSkill>;
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
};

/** Formats an ISO timestamp as an UTC "YYYY-MM-DD HH:MM:SS" string. */
export function formatObservedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
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
