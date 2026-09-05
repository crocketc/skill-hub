import {
  executeCommand,
  queryApplication,
  type DiscoverySnapshot,
  type ScanResult,
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
