export type RepositoryScanTone = "neutral" | "positive" | "negative" | "warning";

export interface RepositoryScanViewModel {
  label: string;
  value: string;
  detail?: string;
  tone: RepositoryScanTone;
}

/** Stable, user-facing projection shared by repository discovery and management. */
export interface RepositoryCardViewModel {
  id: string;
  coordinates: string;
  branchLabel: string;
  branch: string;
  sourceLabel: string;
  enabled: boolean;
  enabledLabel: string;
  scan: RepositoryScanViewModel;
}
