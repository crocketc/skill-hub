import { expect, it } from "vitest";
import { createMockSkillLibraryFacade } from "./testFixtures";

it("returns different deterministic rows for each preview page", async () => {
  const facade = createMockSkillLibraryFacade({ total: 80 });
  const query = {
    filters: { aiCheck: [], basicCheck: [], deployment: "any" as const, lifecycle: [], tags: [], version: "any" as const },
    page: 1,
    pageSize: 25 as const,
    sort: { column: "name" as const, direction: "asc" as const },
    text: "",
  };

  const firstPage = await facade.listSkills(query);
  const secondPage = await facade.listSkills({ ...query, page: 2 });

  expect(firstPage.items).toHaveLength(25);
  expect(secondPage.items).toHaveLength(25);
  expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
  expect(secondPage.items[0]?.name).toBe("Local Skill 26");
});
