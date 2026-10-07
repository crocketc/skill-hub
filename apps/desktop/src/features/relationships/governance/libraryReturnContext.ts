import { parseSkillLibrarySearchParams, serializeSkillLibrarySearchParams } from "../../skills/queryState";
import { readLibraryReturnState, type SkillLibraryReturnState } from "../../skill-detail/detailContext";

export interface GovernanceLibraryReturnTarget {
  to: string;
  state: { libraryReturn: SkillLibraryReturnState } | undefined;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DETAIL_ANCHORS = new Set([
  "identity", "status", "content", "relations", "lifecycle",
  "overview", "metadata", "description", "requirements", "security",
  "connections", "external", "versions",
]);

function validSkillId(skillId: string): boolean {
  return Boolean(
    skillId &&
      skillId !== "." &&
      skillId !== ".." &&
      !/[\\/%?#]/.test(skillId) &&
      !CONTROL_CHARACTERS.test(skillId),
  );
}

function canonicalSearch(search: string): string {
  const parsed = parseSkillLibrarySearchParams(search);
  // `skill` 是库页重开快捷抽屉的参数，返回上下文必须原样保留。
  const serialized = serializeSkillLibrarySearchParams(parsed.query, parsed.skillId).toString();
  return serialized ? `?${serialized}` : "";
}

/** Builds the only return route accepted for a library-origin governance deep link. */
export function buildGovernanceLibraryReturnTo(
  skillId: string,
  backSearch: string,
  hash = "",
): string | undefined {
  if (!validSkillId(skillId)) return undefined;
  const validHash = hash && DETAIL_ANCHORS.has(hash.replace(/^#/, ""))
    ? `#${hash.replace(/^#/, "")}`
    : "";
  return `/library/${encodeURIComponent(skillId)}${canonicalSearch(backSearch)}${validHash}`;
}

/**
 * Builds the drawer-origin return route: back to the library list with the
 * quick drawer reopened for the Skill (the `skill` query parameter).
 */
export function buildGovernanceDrawerReturnTo(
  skillId: string,
  search: string,
): string | undefined {
  if (!validSkillId(skillId)) return undefined;
  const parsed = parseSkillLibrarySearchParams(search);
  const serialized = serializeSkillLibrarySearchParams(parsed.query, skillId).toString();
  return `/library?${serialized}`;
}

function parseAllowedReturnTo(candidate: unknown): { to: string; skillId: string } | undefined {
  if (
    typeof candidate !== "string" ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    CONTROL_CHARACTERS.test(candidate) ||
    candidate.trim() !== candidate
  ) {
    return undefined;
  }

  const rawPath = candidate.split(/[?#]/, 1)[0];
  const pathMatch = /^\/library\/([^/]+)$/.exec(rawPath);
  const drawerPath = rawPath === "/library";
  if (!pathMatch && !drawerPath) return undefined;

  let skillId: string;
  if (pathMatch) {
    try {
      skillId = decodeURIComponent(pathMatch[1]);
    } catch {
      return undefined;
    }
    if (!validSkillId(skillId) || encodeURIComponent(skillId) !== pathMatch[1]) {
      return undefined;
    }
  } else {
    skillId = "";
  }

  let url: URL;
  try {
    url = new URL(candidate, window.location.origin);
  } catch {
    return undefined;
  }
  if (url.origin !== window.location.origin || url.username || url.password || url.pathname !== rawPath) {
    return undefined;
  }

  const params = new URLSearchParams(url.search);
  for (const [key, value] of params) {
    if (CONTROL_CHARACTERS.test(key) || CONTROL_CHARACTERS.test(value) || value.includes("\\")) {
      return undefined;
    }
  }

  // 抽屉返回形状：Skill 身份随 `skill` 查询参数（与库页重开抽屉的参数一致）
  // 携带，必须恰好出现一次且通过 Skill id 校验。
  if (drawerPath) {
    const skillParam = params.getAll("skill");
    if (skillParam.length !== 1 || !validSkillId(skillParam[0])) return undefined;
    skillId = skillParam[0];
  }

  if (canonicalSearch(url.search) !== url.search) return undefined;

  const hash = url.hash ? url.hash.slice(1) : "";
  if (hash && !DETAIL_ANCHORS.has(hash)) return undefined;

  return { to: `${url.pathname}${url.search}${url.hash}`, skillId };
}

/** Revalidates router state and keeps the existing library-return shape validator authoritative. */
export function readGovernanceLibraryReturnTarget(
  state: unknown,
  expectedSkillId: string | undefined,
): GovernanceLibraryReturnTarget | undefined {
  if (!state || typeof state !== "object" || !("returnTo" in state)) return undefined;
  const parsed = parseAllowedReturnTo(state.returnTo);
  if (!parsed || !expectedSkillId || parsed.skillId !== expectedSkillId) return undefined;
  const libraryReturn = readLibraryReturnState(state);
  return {
    to: parsed.to,
    state: libraryReturn ? { libraryReturn } : undefined,
  };
}
