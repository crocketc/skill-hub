import {
  DEFAULT_DRAWER_PREFERENCES,
  DEFAULT_SKILL_QUERY,
  DEFAULT_TABLE_PREFERENCES,
  type SavedSkillView,
  type SkillBatchIntent,
  type SkillDrawerPreferences,
  type SkillLibraryFacade,
  type SkillLibraryQuery,
  type SkillQuickView,
  type SkillTablePreferences,
  type SkillTableRow,
} from "./api";

export interface MockSkillLibraryOptions {
  failDrawerSave?: boolean;
  failPage?: Error;
  matchingSkillIds?: string[];
  pageItems?: SkillTableRow[];
  total?: number;
}

export interface MockSkillLibraryFacade extends SkillLibraryFacade {
  calls: {
    emitBatchIntent: SkillBatchIntent[];
    deleteView: string[];
    listSkills: SkillLibraryQuery[];
    saveDrawerPreferences: SkillDrawerPreferences[];
    saveTablePreferences: SkillTablePreferences[];
    saveView: Array<Omit<SavedSkillView, "builtIn" | "id">>;
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const MOCK_SKILL_PDF: SkillTableRow = {
  aiCheck: "unavailable",
  agentDeploymentCount: 2,
  alias: "reader",
  basicCheck: "passed",
  currentVersion: "1.4.0",
  highRiskCount: 1,
  id: "skill-pdf",
  invocation: "pdf-reader <file>",
  license: "MIT",
  lifecycle: "active",
  name: "PDF Reader",
  originalDescription: "Extracts text and tables from PDF files.",
  ownership: "Platform team",
  pendingCount: 1,
  projectDeploymentCount: 3,
  purpose: "Read and extract PDFs",
  requirements: ["Python 3.11"],
  source: "Internal catalog",
  tags: ["documents", "pdf"],
  translatedDescription: "Reads PDF files.",
  upgradeAvailable: true,
};

export const MOCK_SKILL_DOCX: SkillTableRow = {
  aiCheck: "not_run",
  agentDeploymentCount: 1,
  basicCheck: "passed",
  currentVersion: "2.1.0",
  highRiskCount: 0,
  id: "skill-docx",
  invocation: "docx-writer <document>",
  license: "MIT",
  lifecycle: "active",
  name: "DOCX Writer",
  originalDescription: "Creates and updates Word documents.",
  ownership: "User",
  pendingCount: 0,
  projectDeploymentCount: 2,
  purpose: "Create Word documents",
  requirements: [],
  source: "Local import",
  tags: ["documents", "word"],
  upgradeAvailable: false,
};

export const MOCK_SKILL_BROWSER: SkillTableRow = {
  aiCheck: "passed",
  agentDeploymentCount: 3,
  basicCheck: "warning",
  currentVersion: "0.9.0",
  highRiskCount: 0,
  id: "skill-browser",
  invocation: "browser <url>",
  license: "Apache-2.0",
  lifecycle: "trial",
  name: "Browser Automation",
  originalDescription: "Automates browser navigation and form workflows.",
  ownership: "User",
  pendingCount: 2,
  projectDeploymentCount: 1,
  purpose: "Automate browser workflows",
  requirements: ["Chromium"],
  source: "Local import",
  tags: ["automation", "browser"],
  upgradeAvailable: false,
};

const NAMED_ROWS = [MOCK_SKILL_PDF, MOCK_SKILL_DOCX, MOCK_SKILL_BROWSER];

function generatedRow(index: number): SkillTableRow {
  const ordinal = String(index + 1).padStart(2, "0");
  return {
    ...MOCK_SKILL_DOCX,
    agentDeploymentCount: index % 4,
    id: `skill-${ordinal}`,
    lifecycle: index % 5 === 0 ? "trial" : "active",
    name: `Local Skill ${ordinal}`,
    projectDeploymentCount: index % 3,
    purpose: `Deterministic local skill ${ordinal}`,
    tags: [index % 2 === 0 ? "automation" : "documents"],
  };
}

function defaultRows(count: number): SkillTableRow[] {
  return Array.from({ length: count }, (_, index) =>
    index < NAMED_ROWS.length ? NAMED_ROWS[index] : generatedRow(index),
  );
}

function quickView(row: SkillTableRow): SkillQuickView {
  return {
    ...clone(row),
    dependencies: row.id === "skill-pdf" ? ["pymupdf"] : [],
    duplicateCandidates: [],
    externalChanges: [],
    usageEvidence:
      row.id === "skill-pdf"
        ? { invocationCount: 12, lastUsedAt: "2026-08-24T10:00:00Z" }
        : undefined,
  };
}

const USER_SAVED_VIEW: SavedSkillView = {
  builtIn: false,
  id: "documents",
  name: "Document tools",
  query: {
    filters: { ...clone(DEFAULT_SKILL_QUERY.filters), tags: ["documents"] },
    sort: clone(DEFAULT_SKILL_QUERY.sort),
    text: "",
  },
  table: clone(DEFAULT_TABLE_PREFERENCES),
};

export function createMockSkillLibraryFacade(
  options: MockSkillLibraryOptions = {},
): MockSkillLibraryFacade {
  const calls: MockSkillLibraryFacade["calls"] = {
    deleteView: [],
    emitBatchIntent: [],
    listSkills: [],
    saveDrawerPreferences: [],
    saveTablePreferences: [],
    saveView: [],
  };
  const total = options.total ?? options.pageItems?.length ?? NAMED_ROWS.length;
  let savedViews = [USER_SAVED_VIEW];

  return {
    calls,
    async emitBatchIntent(intent) {
      calls.emitBatchIntent.push(clone(intent));
    },
    async getSkillQuickView(skillId) {
      const available = options.pageItems ?? NAMED_ROWS;
      const row = available.find((item) => item.id === skillId) ??
        NAMED_ROWS.find((item) => item.id === skillId) ??
        generatedRow(Number(skillId.replace("skill-", "")) - 1);
      return clone(quickView(row));
    },
    async listSavedViews() {
      return clone(savedViews);
    },
    async deleteView(viewId) {
      calls.deleteView.push(viewId);
      savedViews = savedViews.filter((view) => view.id !== viewId);
    },
    async listSkills(query) {
      calls.listSkills.push(clone(query));
      if (options.failPage) {
        throw options.failPage;
      }

      const itemCount = options.total === undefined
        ? Math.min(query.pageSize, total)
        : Math.min(query.pageSize, Math.max(total - (query.page - 1) * query.pageSize, 0));
      const allRows = options.pageItems ?? defaultRows(total);
      const start = (query.page - 1) * query.pageSize;
      // Keep the small default fixture backwards-compatible for tests that only
      // need a row regardless of URL page state. Explicit totals opt into the
      // deterministic multi-page preview used by the browser shell.
      const items = options.pageItems ?? (
        options.total === undefined ? defaultRows(itemCount) : allRows.slice(start, start + itemCount)
      );
      return clone({
        facets: {
          tags: [...new Set(allRows.flatMap((row) => row.tags))].sort(),
        },
        items,
        page: query.page,
        pageSize: query.pageSize,
        total,
      });
    },
    async loadDrawerPreferences() {
      return clone(DEFAULT_DRAWER_PREFERENCES);
    },
    async loadTablePreferences() {
      return clone(DEFAULT_TABLE_PREFERENCES);
    },
    async retainMatchingSkillIds(skillIds) {
      const matching = new Set(options.matchingSkillIds ?? skillIds);
      return clone(skillIds.filter((skillId) => matching.has(skillId)));
    },
    async saveDrawerPreferences(preferences) {
      calls.saveDrawerPreferences.push(clone(preferences));
      if (options.failDrawerSave) {
        throw new Error("drawer preference save failed");
      }
    },
    async saveTablePreferences(preferences) {
      calls.saveTablePreferences.push(clone(preferences));
    },
    async saveView(view) {
      const saved = clone(view);
      calls.saveView.push(saved);
      const result = {
        ...clone(saved),
        builtIn: false,
        id: `saved-${calls.saveView.length}`,
      };
      savedViews = [...savedViews, result];
      return clone(result);
    },
  };
}
