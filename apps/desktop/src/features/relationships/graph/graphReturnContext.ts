import { parseSkillLibrarySearchParams, serializeSkillLibrarySearchParams } from "../../skills/queryState";
import { readLibraryReturnState, type SkillLibraryReturnState } from "../../skill-detail/detailContext";

const SOURCE_CONTEXT_VERSION = 1;
const SOURCE_CONTEXT_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_RETURN_ROUTE_LENGTH = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DETAIL_ANCHORS = new Set([
  "review-overview",
  "review-content",
  "review-safety",
  "review-usage",
  "review-sources",
  "review-versions",
]);

export type GraphSourceKind = "drawer" | "detail";

export interface GraphSourceContext {
  kind: GraphSourceKind;
  skillId: string;
  version: typeof SOURCE_CONTEXT_VERSION;
  issuedAt: number;
  returnTo: string;
  libraryReturn?: SkillLibraryReturnState;
}

export interface GraphReturnTarget {
  kind: GraphSourceKind;
  to: string;
  state: { libraryReturn: SkillLibraryReturnState } | undefined;
}

function validSkillId(skillId: string): boolean {
  return Boolean(
    skillId.trim()
      && skillId !== "."
      && skillId !== ".."
      && !/[\\/%?#]/.test(skillId)
      && !CONTROL_CHARACTERS.test(skillId),
  );
}

function validLibraryReturn(
  value: SkillLibraryReturnState | undefined,
  skillId: string,
): SkillLibraryReturnState | undefined {
  if (!value || value.focusSkillId !== skillId) return undefined;
  return readLibraryReturnState({ libraryReturn: value });
}

function buildContext(
  kind: GraphSourceKind,
  skillId: string,
  returnTo: string,
  libraryReturn: SkillLibraryReturnState | undefined,
  issuedAt: number,
): GraphSourceContext | undefined {
  if (!validSkillId(skillId) || !Number.isFinite(issuedAt)) return undefined;
  return {
    issuedAt,
    kind,
    ...(libraryReturn ? { libraryReturn } : {}),
    returnTo,
    skillId,
    version: SOURCE_CONTEXT_VERSION,
  };
}

/** Build a canonical library target that reopens the current drawer and keeps filters. */
export function createDrawerGraphReturnContext(input: {
  skillId: string;
  pathname: string;
  search: string;
  libraryReturn?: SkillLibraryReturnState;
  now?: number;
}): GraphSourceContext | undefined {
  const { skillId, pathname, search, libraryReturn, now = Date.now() } = input;
  if (pathname !== "/library" && pathname !== "/__preview/skill-library") return undefined;
  if (!validSkillId(skillId)) return undefined;

  const parsed = parseSkillLibrarySearchParams(search);
  const params = serializeSkillLibrarySearchParams(parsed.query, skillId);
  const basePath = pathname === "/library" ? "/library" : "/__preview/skill-library";
  const returnTo = `${basePath}?${params.toString()}`;
  return buildContext("drawer", skillId, returnTo, validLibraryReturn(libraryReturn, skillId), now);
}

/** Build an allowlisted detail target while retaining its current library context. */
export function createDetailGraphReturnContext(input: {
  skillId: string;
  pathname: string;
  search: string;
  hash?: string;
  state: unknown;
  now?: number;
}): GraphSourceContext | undefined {
  const { skillId, pathname, search, hash = "", state, now = Date.now() } = input;
  if (!validSkillId(skillId)) return undefined;
  const encodedSkillId = encodeURIComponent(skillId);
  const allowedPaths = new Set([`/library/${encodedSkillId}`, `/__preview/skill-detail/${encodedSkillId}`]);
  if (!allowedPaths.has(pathname) || !isSafeSearch(search)) return undefined;

  const anchor = hash.startsWith("#") ? hash.slice(1) : hash;
  const safeHash = anchor && DETAIL_ANCHORS.has(anchor) ? `#${anchor}` : "";
  const returnTo = `${pathname}${search}${safeHash}`;
  const parsedLibraryReturn = readLibraryReturnState(state);
  if (parsedLibraryReturn && parsedLibraryReturn.focusSkillId !== skillId) return undefined;
  return buildContext("detail", skillId, returnTo, parsedLibraryReturn, now);
}

function isSafeSearch(search: string): boolean {
  return search.length <= MAX_RETURN_ROUTE_LENGTH
    && !CONTROL_CHARACTERS.test(search)
    && !search.includes("\\");
}

function parseAllowedTarget(
  candidate: unknown,
  kind: GraphSourceKind,
  skillId: string,
): string | undefined {
  if (
    typeof candidate !== "string"
    || candidate.length > MAX_RETURN_ROUTE_LENGTH
    || !candidate.startsWith("/")
    || candidate.startsWith("//")
    || candidate.includes("\\")
    || CONTROL_CHARACTERS.test(candidate)
    || candidate.trim() !== candidate
  ) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(candidate, "https://skillhub.invalid");
  } catch {
    return undefined;
  }
  if (url.origin !== "https://skillhub.invalid" || url.username || url.password) return undefined;

  const encodedSkillId = encodeURIComponent(skillId);
  if (kind === "drawer") {
    if (url.pathname !== "/library" && url.pathname !== "/__preview/skill-library") return undefined;
    const rawQuery = candidate.includes("?") ? candidate.slice(candidate.indexOf("?") + 1).split("#", 1)[0] : "";
    const params = new URLSearchParams(rawQuery);
    const skillParams = params.getAll("skill");
    if (skillParams.length !== 1 || skillParams[0] !== skillId || url.hash) return undefined;
    const parsed = parseSkillLibrarySearchParams(params);
    if (serializeSkillLibrarySearchParams(parsed.query, skillId).toString() !== rawQuery) return undefined;
  } else {
    if (url.pathname !== `/library/${encodedSkillId}` && url.pathname !== `/__preview/skill-detail/${encodedSkillId}`) return undefined;
    const hash = url.hash.slice(1);
    if (hash && !DETAIL_ANCHORS.has(hash)) return undefined;
    if (!isSafeSearch(url.search)) return undefined;
    // URL 的 query/hash 规范化不能静默改变待恢复地址。
    const routeSuffix = `${url.search}${url.hash}`;
    const candidateSuffix = candidate.slice(url.pathname.length);
    if (routeSuffix !== candidateSuffix) return undefined;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

/** Revalidate location state and allow navigation only to the matching in-app source route. */
export function readGraphReturnTarget(
  state: unknown,
  now = Date.now(),
): GraphReturnTarget | undefined {
  if (!state || typeof state !== "object" || !("graphSource" in state)) return undefined;
  const sourceValue = state.graphSource;
  if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) return undefined;
  const source = sourceValue as Record<string, unknown>;

  const kind = source.kind;
  const skillId = source.skillId;
  const issuedAt = source.issuedAt;
  if (
    (kind !== "drawer" && kind !== "detail")
    || typeof skillId !== "string"
    || !validSkillId(skillId)
    || source.version !== SOURCE_CONTEXT_VERSION
    || typeof issuedAt !== "number"
    || !Number.isFinite(issuedAt)
    || issuedAt > now + 60_000
    || now - issuedAt > SOURCE_CONTEXT_MAX_AGE_MS
  ) {
    return undefined;
  }

  const to = parseAllowedTarget(source.returnTo, kind, skillId);
  if (!to) return undefined;
  const hasLibraryReturn = "libraryReturn" in source;
  const libraryReturn = readLibraryReturnState(source);
  if (hasLibraryReturn && (!libraryReturn || libraryReturn.focusSkillId !== skillId)) return undefined;

  return {
    kind,
    state: libraryReturn ? { libraryReturn } : undefined,
    to,
  };
}
