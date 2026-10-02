export interface PendingLibraryReview {
  skillIds: string[];
  intent: "security_check" | "source_update";
  returnTo: string;
}

/** Navigation can prepare a selection, never authorize an operation. */
export function readPendingLibraryReview(state: unknown): PendingLibraryReview | undefined {
  if (!state || typeof state !== "object" || !("pendingReview" in state)) return undefined;
  const value = state.pendingReview;
  if (!value || typeof value !== "object") return undefined;
  if (!("intent" in value) || (value.intent !== "security_check" && value.intent !== "source_update")) return undefined;
  if (!("returnTo" in value) || typeof value.returnTo !== "string" || !/^\/pending(?:\?|$)/.test(value.returnTo)) return undefined;
  if (!("skillIds" in value) || !Array.isArray(value.skillIds)
    || !value.skillIds.length || !value.skillIds.every((id): id is string => typeof id === "string" && id.trim().length > 0)) return undefined;
  return { intent: value.intent, returnTo: value.returnTo, skillIds: [...new Set(value.skillIds)] };
}
