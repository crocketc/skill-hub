import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRAWER_PREFERENCES,
  DEFAULT_SKILL_QUERY,
  DEFAULT_TABLE_PREFERENCES,
  isSkillLibraryUnavailable,
  unavailableSkillLibraryFacade,
} from "./api";

describe("Skill library facade defaults", () => {
  it("defaults to compact rows, 25 items, and a wide drawer", () => {
    expect(DEFAULT_SKILL_QUERY.pageSize).toBe(25);
    expect(DEFAULT_TABLE_PREFERENCES.density).toBe("compact");
    expect(DEFAULT_DRAWER_PREFERENCES.preset).toBe("wide");
    expect(DEFAULT_DRAWER_PREFERENCES.widthPx).toBe(680);
  });

  it("starts with the screenshot column order and visible set", () => {
    expect(DEFAULT_TABLE_PREFERENCES.columnOrder.slice(0, 8)).toEqual([
      "select",
      "name",
      "purpose",
      "tags",
      "invocation",
      "agent_deployments",
      "project_deployments",
      "security",
    ]);
    expect(DEFAULT_TABLE_PREFERENCES.visibleColumns).toEqual([
      "select",
      "name",
      "purpose",
      "tags",
      "invocation",
      "agent_deployments",
      "project_deployments",
      "security",
    ]);
  });

  it("classifies only the missing production contract as unavailable", async () => {
    const error = await unavailableSkillLibraryFacade
      .listSkills(DEFAULT_SKILL_QUERY)
      .catch((reason: unknown) => reason);
    expect(isSkillLibraryUnavailable(error)).toBe(true);
    expect(isSkillLibraryUnavailable(new Error("disk read failed"))).toBe(false);
  });

  it("keeps only local fallback reads available while rejecting unavailable mutations", async () => {
    await expect(unavailableSkillLibraryFacade.listSavedViews()).resolves.toEqual([]);
    await expect(unavailableSkillLibraryFacade.retainMatchingSkillIds(["skill-1"], DEFAULT_SKILL_QUERY)).resolves.toEqual([]);
    await expect(unavailableSkillLibraryFacade.loadTablePreferences()).resolves.toBe(
      DEFAULT_TABLE_PREFERENCES,
    );
    await expect(unavailableSkillLibraryFacade.loadDrawerPreferences()).resolves.toBe(
      DEFAULT_DRAWER_PREFERENCES,
    );
    await expect(unavailableSkillLibraryFacade.saveTablePreferences(DEFAULT_TABLE_PREFERENCES)).rejects.toSatisfy(
      isSkillLibraryUnavailable,
    );
  });
});
