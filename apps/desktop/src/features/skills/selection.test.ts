import { describe, expect, it } from "vitest";
import { DEFAULT_SKILL_QUERY } from "./api";
import {
  excludeFromAllFiltered,
  retainExplicitSelection,
  selectAllFiltered,
  selectExplicit,
  setPageSelection,
  selectionCount,
  selectionToBatchTarget,
} from "./selection";

describe("Skill selection", () => {
  it("keeps explicit IDs across pages", () => {
    const first = selectExplicit({ kind: "none" }, ["a", "b"], true);
    const second = selectExplicit(first, ["c"], true);
    expect(second).toEqual({ kind: "explicit", skillIds: ["a", "b", "c"] });
  });

  it("represents all filtered results without materializing every ID", () => {
    const filter = {
      filters: DEFAULT_SKILL_QUERY.filters,
      text: DEFAULT_SKILL_QUERY.text,
    };
    const selected = selectAllFiltered(filter, "filter:v1", 80);
    const excluded = excludeFromAllFiltered(selected, "skill-17", true);
    expect(selectionToBatchTarget(excluded)).toEqual({
      kind: "filtered",
      filter,
      excludedSkillIds: ["skill-17"],
    });
  });

  it("normalizes explicit IDs and clears the selection after the last removal", () => {
    const selected = selectExplicit({ kind: "none" }, ["b", "a", "b"], true);
    expect(selected).toEqual({ kind: "explicit", skillIds: ["a", "b"] });
    expect(selectExplicit(selected, ["a", "b", "b"], false)).toEqual({ kind: "none" });
  });

  it("orders persisted selection IDs by code unit instead of locale", () => {
    const selected = selectExplicit({ kind: "none" }, ["z", "ä", "A", "a"], true);
    expect(selected).toEqual({ kind: "explicit", skillIds: ["A", "a", "z", "ä"] });
  });

  it("clones filter snapshots and retains only matching explicit IDs", () => {
    const filter = {
      filters: { ...DEFAULT_SKILL_QUERY.filters, tags: ["docs"] },
      text: "reader",
    };
    const selected = selectAllFiltered(filter, "filter:v1", 2);
    filter.filters.tags.push("changed-after-selection");

    expect(selected.filter.filters.tags).toEqual(["docs"]);
    expect(retainExplicitSelection({ kind: "explicit", skillIds: ["b", "a"] }, ["b"])).toEqual({
      kind: "explicit",
      skillIds: ["b"],
    });
  });

  it("counts the selected scope and emits sorted explicit targets", () => {
    const selected = selectExplicit({ kind: "none" }, ["b", "a", "b"], true);
    const allFiltered = excludeFromAllFiltered(
      selectAllFiltered({ filters: DEFAULT_SKILL_QUERY.filters, text: "" }, "filter:v1", 3),
      "skill-2",
      true,
    );

    expect(selectionCount(selected)).toBe(2);
    expect(selectionCount(allFiltered)).toBe(2);
    if (selected.kind === "none") {
      throw new Error("expected an explicit selection");
    }
    expect(selectionToBatchTarget(selected)).toEqual({ kind: "skill_ids", skillIds: ["a", "b"] });
  });

  it("adds only the current page to all-filtered exclusions without losing its snapshot", () => {
    const filter = {
      filters: { ...DEFAULT_SKILL_QUERY.filters, tags: ["docs"] },
      text: "reader",
    };
    const selected = {
      ...selectAllFiltered(filter, "filter:reader", 80),
      excludedSkillIds: ["skill-other-page"],
    };

    const next = setPageSelection(selected, ["skill-z", "skill-a"], false);

    expect(next).toEqual({
      excludedSkillIds: ["skill-a", "skill-other-page", "skill-z"],
      filter,
      filterKey: "filter:reader",
      kind: "all_filtered",
      total: 80,
    });
    if (next.kind !== "all_filtered") throw new Error("expected all-filtered selection");
    expect(next.filter).not.toBe(selected.filter);
    expect(next.filter.filters.tags).not.toBe(selected.filter.filters.tags);
  });

  it("removes only the current page from all-filtered exclusions", () => {
    const selected = {
      ...selectAllFiltered(
        { filters: DEFAULT_SKILL_QUERY.filters, text: "" },
        "filter:all",
        80,
      ),
      excludedSkillIds: ["skill-a", "skill-other-page", "skill-z"],
    };

    expect(setPageSelection(selected, ["skill-z", "skill-a"], true)).toEqual({
      excludedSkillIds: ["skill-other-page"],
      filter: { filters: DEFAULT_SKILL_QUERY.filters, text: "" },
      filterKey: "filter:all",
      kind: "all_filtered",
      total: 80,
    });
  });
});
