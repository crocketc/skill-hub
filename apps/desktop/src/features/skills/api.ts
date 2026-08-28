export type SkillLifecycle = "active" | "trial" | "archived";
export type CheckState = "passed" | "warning" | "failed" | "not_run" | "unavailable";
export type SkillDensity = "compact" | "standard" | "comfortable";
export type DrawerPreset = "standard" | "wide" | "near_full";
export type SkillColumnId =
  | "select"
  | "name"
  | "purpose"
  | "tags"
  | "lifecycle"
  | "deployments"
  | "version"
  | "security"
  | "original_description"
  | "translated_description"
  | "source"
  | "ownership"
  | "license"
  | "invocation"
  | "requirements";

export interface SkillLibraryFilters {
  aiCheck: CheckState[];
  basicCheck: CheckState[];
  deployment: "any" | "deployed" | "not_deployed";
  lifecycle: SkillLifecycle[];
  tags: string[];
  version: "any" | "upgrade_available";
}

export interface SkillLibraryQuery {
  filters: SkillLibraryFilters;
  page: number;
  pageSize: 10 | 25 | 50 | 100;
  savedViewId?: string;
  sort: { column: SkillColumnId; direction: "asc" | "desc" };
  text: string;
}

export interface SkillTableRow {
  aiCheck: CheckState;
  agentDeploymentCount: number;
  alias?: string;
  basicCheck: CheckState;
  currentVersion: string;
  highRiskCount: number;
  id: string;
  invocation?: string;
  license?: string;
  lifecycle: SkillLifecycle;
  name: string;
  originalDescription?: string;
  ownership?: string;
  pendingCount: number;
  projectDeploymentCount: number;
  purpose: string;
  requirements: string[];
  source?: string;
  tags: string[];
  translatedDescription?: string;
  upgradeAvailable: boolean;
}

export interface SkillPage {
  facets: { tags: string[] };
  items: SkillTableRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface SkillQuickView extends SkillTableRow {
  dependencies: string[];
  duplicateCandidates: string[];
  externalChanges: string[];
  note?: string;
  usageEvidence?: { invocationCount: number; lastUsedAt?: string };
}

export interface SkillMetadataPatch {
  alias?: string | null;
  note?: string | null;
}

export interface SkillTablePreferences {
  columnOrder: SkillColumnId[];
  density: SkillDensity;
  visibleColumns: SkillColumnId[];
}

export type DrawerModuleId =
  | "identity"
  | "primary_actions"
  | "risk_summary"
  | "full_details"
  | "relations"
  | "versions"
  | "source_license"
  | "security_checks"
  | "invocation_requirements"
  | "dependencies_duplicates"
  | "external_changes"
  | "usage_evidence";

export interface SkillDrawerPreferences {
  moduleOrder: DrawerModuleId[];
  preset: DrawerPreset;
  visibleModules: DrawerModuleId[];
  widthPx: number;
}

export interface SavedSkillView {
  builtIn: boolean;
  id: string;
  /** Translation key for built-in views; user-entered label for saved views. */
  name: string;
  query: Pick<SkillLibraryQuery, "filters" | "sort" | "text">;
  table: SkillTablePreferences;
}

export type BatchAction =
  | "add_to"
  | "security_check"
  | "export"
  | "archive"
  | "add_tag"
  | "remove_tag";
export type SkillFilterSnapshot = Pick<SkillLibraryQuery, "filters" | "text">;
export type BatchTarget =
  | { kind: "skill_ids"; skillIds: string[] }
  | { kind: "filtered"; filter: SkillFilterSnapshot; excludedSkillIds: string[] };
export interface SkillBatchIntent {
  action: BatchAction;
  target: BatchTarget;
  /** Tags supplied by the batch tag workflow. Other actions omit this field. */
  tags?: string[];
}

export interface SkillLibraryFacade {
  emitBatchIntent(intent: SkillBatchIntent): Promise<void>;
  getSkillQuickView(skillId: string): Promise<SkillQuickView>;
  listSavedViews(): Promise<SavedSkillView[]>;
  listSkills(query: SkillLibraryQuery): Promise<SkillPage>;
  loadDrawerPreferences(): Promise<SkillDrawerPreferences>;
  loadTablePreferences(): Promise<SkillTablePreferences>;
  retainMatchingSkillIds(skillIds: string[], query: SkillLibraryQuery): Promise<string[]>;
  saveDrawerPreferences(preferences: SkillDrawerPreferences): Promise<void>;
  saveSkillMetadata?: (skillId: string, patch: SkillMetadataPatch) => Promise<void>;
  saveTablePreferences(preferences: SkillTablePreferences): Promise<void>;
  deleteView(viewId: string): Promise<void>;
  saveView(view: Omit<SavedSkillView, "builtIn" | "id">): Promise<SavedSkillView>;
}

function freeze<T>(value: T): T {
  return Object.freeze(value) as T;
}

const DEFAULT_SKILL_FILTERS = freeze<SkillLibraryFilters>({
  aiCheck: freeze<CheckState[]>([]),
  basicCheck: freeze<CheckState[]>([]),
  deployment: "any",
  lifecycle: freeze<SkillLifecycle[]>([]),
  tags: freeze<string[]>([]),
  version: "any",
});

const SKILL_COLUMN_ORDER = freeze<SkillColumnId[]>([
  "select",
  "name",
  "purpose",
  "tags",
  "invocation",
  "deployments",
  "security",
  "version",
  "original_description",
  "translated_description",
  "source",
  "ownership",
  "license",
  "requirements",
  "lifecycle",
]);

const DEFAULT_VISIBLE_COLUMNS = freeze<SkillColumnId[]>([
  "select",
  "name",
  "purpose",
  "tags",
  "invocation",
  "deployments",
  "security",
]);

const DRAWER_MODULE_ORDER = freeze<DrawerModuleId[]>([
  "identity",
  "primary_actions",
  "risk_summary",
  "full_details",
  "relations",
  "versions",
  "source_license",
  "security_checks",
  "invocation_requirements",
  "dependencies_duplicates",
  "external_changes",
  "usage_evidence",
]);

export const DEFAULT_SKILL_QUERY = freeze<SkillLibraryQuery>({
  filters: DEFAULT_SKILL_FILTERS,
  page: 1,
  pageSize: 25,
  sort: freeze({ column: "name", direction: "asc" }),
  text: "",
});

export const DEFAULT_TABLE_PREFERENCES = freeze<SkillTablePreferences>({
  columnOrder: SKILL_COLUMN_ORDER,
  density: "compact",
  visibleColumns: DEFAULT_VISIBLE_COLUMNS,
});

export const DEFAULT_DRAWER_PREFERENCES = freeze<SkillDrawerPreferences>({
  moduleOrder: DRAWER_MODULE_ORDER,
  preset: "wide",
  visibleModules: DRAWER_MODULE_ORDER,
  widthPx: 680,
});

function savedViewQuery(filters: SkillLibraryFilters): SavedSkillView["query"] {
  return freeze({ filters, sort: DEFAULT_SKILL_QUERY.sort, text: DEFAULT_SKILL_QUERY.text });
}

export const BUILT_IN_SAVED_VIEWS = freeze<SavedSkillView[]>([
  freeze<SavedSkillView>({
    builtIn: true,
    id: "all",
    name: "skillLibrary.savedViews.builtIn.all",
    query: savedViewQuery(DEFAULT_SKILL_FILTERS),
    table: DEFAULT_TABLE_PREFERENCES,
  }),
  freeze<SavedSkillView>({
    builtIn: true,
    id: "active",
    name: "skillLibrary.savedViews.builtIn.active",
    query: savedViewQuery(
      freeze<SkillLibraryFilters>({
        ...DEFAULT_SKILL_FILTERS,
        lifecycle: freeze<SkillLifecycle[]>(["active"]),
      }),
    ),
    table: DEFAULT_TABLE_PREFERENCES,
  }),
  freeze<SavedSkillView>({
    builtIn: true,
    id: "attention",
    name: "skillLibrary.savedViews.builtIn.attention",
    query: savedViewQuery(
      freeze<SkillLibraryFilters>({
        ...DEFAULT_SKILL_FILTERS,
        aiCheck: freeze<CheckState[]>(["warning", "failed"]),
        basicCheck: freeze<CheckState[]>(["warning", "failed"]),
      }),
    ),
    table: DEFAULT_TABLE_PREFERENCES,
  }),
  freeze<SavedSkillView>({
    builtIn: true,
    id: "updates",
    name: "skillLibrary.savedViews.builtIn.updates",
    query: savedViewQuery(
      freeze<SkillLibraryFilters>({ ...DEFAULT_SKILL_FILTERS, version: "upgrade_available" }),
    ),
    table: DEFAULT_TABLE_PREFERENCES,
  }),
]);

export const skillLibraryKeys = {
  root: ["skill-library"] as const,
  page: (query: SkillLibraryQuery) => ["skill-library", "page", query] as const,
  savedViews: () => ["skill-library", "saved-views"] as const,
  tablePreferences: () => ["skill-library", "table-preferences"] as const,
  drawerPreferences: () => ["skill-library", "drawer-preferences"] as const,
  quickView: (skillId: string) => ["skill-library", "quick-view", skillId] as const,
};

export class SkillLibraryUnavailableError extends Error {
  constructor() {
    super("The Skill library production contract is unavailable.");
    this.name = "SkillLibraryUnavailableError";
  }
}

export function isSkillLibraryUnavailable(error: unknown): error is SkillLibraryUnavailableError {
  return error instanceof SkillLibraryUnavailableError;
}

const EMPTY_SAVED_VIEWS = freeze<SavedSkillView[]>([]);
const EMPTY_SKILL_IDS = freeze<string[]>([]);
const unavailable = (): Promise<never> => Promise.reject(new SkillLibraryUnavailableError());

export const unavailableSkillLibraryFacade: SkillLibraryFacade = {
  emitBatchIntent: unavailable,
  getSkillQuickView: unavailable,
  listSavedViews: async () => EMPTY_SAVED_VIEWS,
  listSkills: unavailable,
  loadDrawerPreferences: async () => DEFAULT_DRAWER_PREFERENCES,
  loadTablePreferences: async () => DEFAULT_TABLE_PREFERENCES,
  retainMatchingSkillIds: async () => EMPTY_SKILL_IDS,
  saveDrawerPreferences: unavailable,
  saveTablePreferences: unavailable,
  deleteView: unavailable,
  saveView: unavailable,
};
