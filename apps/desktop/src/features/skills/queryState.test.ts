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

it("rejects malformed URL enum, page, page-size, and sort values", () => {
  const result = parseSkillLibrarySearchParams(
    "ai=failed&ai=unknown&basic=invalid&lifecycle=trial&lifecycle=trial&lifecycle=unknown&deployment=everywhere&version=old&page=0&size=20&sort=security:sideways",
  );

  expect(result.query).toEqual({
    ...DEFAULT_SKILL_QUERY,
    filters: {
      ...DEFAULT_SKILL_QUERY.filters,
      aiCheck: ["failed"],
      lifecycle: ["trial"],
    },
  });
});

it("clamps non-integer pages and rejects unsupported page sizes", () => {
  const result = parseSkillLibrarySearchParams("page=1.5&size=500");

  expect(result.query.page).toBe(1);
  expect(result.query.pageSize).toBe(25);
});

it("uses repeated normalized filter parameters and omits defaults", () => {
  const params = serializeSkillLibrarySearchParams({
    ...DEFAULT_SKILL_QUERY,
    filters: {
      ...DEFAULT_SKILL_QUERY.filters,
      basicCheck: ["passed", "failed", "passed"],
      tags: ["pdf", "docs", "pdf"],
    },
  });

  expect(params.toString()).toBe("basic=failed&basic=passed&tag=docs&tag=pdf");
});
