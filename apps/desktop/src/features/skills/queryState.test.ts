import { expect, it } from "vitest";
import {
  DEFAULT_SKILL_QUERY,
  DEFAULT_TABLE_PREFERENCES,
  type SkillLibraryQuery,
} from "./api";
import {
  applySavedView,
  parseSkillLibrarySearchParams,
  serializeSkillLibrarySearchParams,
  skillFilterKey,
} from "./queryState";

it("round-trips query and drawer state while normalizing unordered filters", () => {
  const query: SkillLibraryQuery = {
    ...DEFAULT_SKILL_QUERY,
    filters: {
      ...DEFAULT_SKILL_QUERY.filters,
      lifecycle: ["trial", "active"],
      tags: ["pdf", "docs"],
    },
    page: 3,
    text: "reader",
  };

  const params = serializeSkillLibrarySearchParams(query, "skill-pdf");

  expect(parseSkillLibrarySearchParams(params)).toEqual({
    query: {
      ...query,
      filters: { ...query.filters, lifecycle: ["active", "trial"], tags: ["docs", "pdf"] },
    },
    skillId: "skill-pdf",
  });
  expect(skillFilterKey(query)).toBe(skillFilterKey(parseSkillLibrarySearchParams(params).query));
});

it("applies a saved view without copying page or selection", () => {
  const result = applySavedView(DEFAULT_SKILL_QUERY, {
    builtIn: false,
    id: "view-risk",
    name: "Risk review",
    query: {
      filters: { ...DEFAULT_SKILL_QUERY.filters, basicCheck: ["failed"] },
      sort: { column: "security", direction: "desc" },
      text: "",
    },
    table: DEFAULT_TABLE_PREFERENCES,
  });

  expect(result.query.page).toBe(1);
  expect(result.query.savedViewId).toBe("view-risk");
  expect(result.table.density).toBe("compact");
});
