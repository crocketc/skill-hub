import {
  DEFAULT_SKILL_QUERY,
  type CheckState,
  type SavedSkillView,
  type SkillColumnId,
  type SkillLibraryQuery,
  type SkillLifecycle,
} from "./api";

const PARAMS = {
  aiCheck: "ai",
  basicCheck: "basic",
  deployment: "deployment",
  lifecycle: "lifecycle",
  page: "page",
  pageSize: "size",
  savedViewId: "view",
  skillId: "skill",
  sort: "sort",
  tags: "tag",
  text: "q",
  version: "version",
} as const;

const CHECK_STATES: readonly CheckState[] = ["passed", "warning", "failed", "not_run", "unavailable"];
const LIFECYCLES: readonly SkillLifecycle[] = ["active", "trial", "archived"];
const COLUMN_IDS: readonly SkillColumnId[] = [
  "select",
  "name",
  "purpose",
  "tags",
  "lifecycle",
  "agent_deployments",
  "project_deployments",
  "version",
  "security",
  "source",
  "ownership",
  "license",
  "invocation",
  "requirements",
];
const PAGE_SIZES = [10, 25, 50, 100] as const;

function normaliseValues<T extends string>(values: readonly string[], allowed?: readonly T[]): T[] | string[] {
  const permitted = allowed ? values.filter((value): value is T => allowed.includes(value as T)) : values;
  return [...new Set(permitted)].sort();
}

function toSearchParams(params: URLSearchParams | string): URLSearchParams {
  return typeof params === "string" ? new URLSearchParams(params) : params;
}

function parsePage(value: string | null): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function parsePageSize(value: string | null): SkillLibraryQuery["pageSize"] {
  const pageSize = Number(value);
  return PAGE_SIZES.includes(pageSize as (typeof PAGE_SIZES)[number])
    ? (pageSize as SkillLibraryQuery["pageSize"])
    : DEFAULT_SKILL_QUERY.pageSize;
}

function parseEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && allowed.includes(value as T) ? (value as T) : fallback;
}

function parseSort(value: string | null): SkillLibraryQuery["sort"] {
  if (!value) return DEFAULT_SKILL_QUERY.sort;
  const [column, direction, extra] = value.split(":");
  if (
    extra !== undefined ||
    !COLUMN_IDS.includes(column as SkillColumnId) ||
    (direction !== "asc" && direction !== "desc")
  ) {
    return DEFAULT_SKILL_QUERY.sort;
  }
  return { column: column as SkillColumnId, direction };
}

function appendAll(params: URLSearchParams, name: string, values: readonly string[]) {
  values.forEach((value) => params.append(name, value));
}

function appendFilters(params: URLSearchParams, query: SkillLibraryQuery) {
  const { filters } = query;
  appendAll(params, PARAMS.aiCheck, normaliseValues(filters.aiCheck));
  appendAll(params, PARAMS.basicCheck, normaliseValues(filters.basicCheck));
  appendAll(params, PARAMS.lifecycle, normaliseValues(filters.lifecycle));
  appendAll(params, PARAMS.tags, normaliseValues(filters.tags));

  if (filters.deployment !== DEFAULT_SKILL_QUERY.filters.deployment) {
    params.set(PARAMS.deployment, filters.deployment);
  }
  if (filters.version !== DEFAULT_SKILL_QUERY.filters.version) {
    params.set(PARAMS.version, filters.version);
  }
}

export function parseSkillLibrarySearchParams(params: URLSearchParams | string): {
  query: SkillLibraryQuery;
  skillId?: string;
} {
  const source = toSearchParams(params);
  const deployment = parseEnum(source.get(PARAMS.deployment), ["any", "deployed", "not_deployed"], "any");
  const version = parseEnum(source.get(PARAMS.version), ["any", "upgrade_available"], "any");

  return {
    query: {
      filters: {
        aiCheck: normaliseValues(source.getAll(PARAMS.aiCheck), CHECK_STATES) as CheckState[],
        basicCheck: normaliseValues(source.getAll(PARAMS.basicCheck), CHECK_STATES) as CheckState[],
        deployment,
        lifecycle: normaliseValues(source.getAll(PARAMS.lifecycle), LIFECYCLES) as SkillLifecycle[],
        tags: normaliseValues(source.getAll(PARAMS.tags)) as string[],
        version,
      },
      page: parsePage(source.get(PARAMS.page)),
      pageSize: parsePageSize(source.get(PARAMS.pageSize)),
      savedViewId: source.get(PARAMS.savedViewId) || undefined,
      sort: parseSort(source.get(PARAMS.sort)),
      text: source.get(PARAMS.text) ?? "",
    },
    skillId: source.get(PARAMS.skillId) || undefined,
  };
}

export function serializeSkillLibrarySearchParams(
  query: SkillLibraryQuery,
  skillId?: string,
): URLSearchParams {
  const params = new URLSearchParams();
  appendFilters(params, query);

  if (query.text) params.set(PARAMS.text, query.text);
  if (query.page !== DEFAULT_SKILL_QUERY.page) params.set(PARAMS.page, String(query.page));
  if (query.pageSize !== DEFAULT_SKILL_QUERY.pageSize) params.set(PARAMS.pageSize, String(query.pageSize));
  if (
    query.sort.column !== DEFAULT_SKILL_QUERY.sort.column ||
    query.sort.direction !== DEFAULT_SKILL_QUERY.sort.direction
  ) {
    params.set(PARAMS.sort, `${query.sort.column}:${query.sort.direction}`);
  }
  if (query.savedViewId) params.set(PARAMS.savedViewId, query.savedViewId);
  if (skillId) params.set(PARAMS.skillId, skillId);

  return params;
}

export function skillFilterKey(query: SkillLibraryQuery): string {
  const params = new URLSearchParams();
  appendFilters(params, query);
  if (query.text) params.set(PARAMS.text, query.text);
  return params.toString();
}

export function applySavedView(
  currentQuery: SkillLibraryQuery,
  view: SavedSkillView,
): { query: SkillLibraryQuery; table: SavedSkillView["table"] } {
  return {
    query: {
      ...currentQuery,
      ...view.query,
      page: 1,
      savedViewId: view.id,
    },
    table: view.table,
  };
}
