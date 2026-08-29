import { describe, expect, it, vi } from "vitest";
import { queryApplication } from "../../api/bindings";
import { DEFAULT_SKILL_QUERY } from "./api";
import { nativeSkillLibraryFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({
  queryApplication: vi.fn(),
}));

describe("native skill library facade", () => {
  it("maps a typed skill page into the desktop table row contract", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "skill_page",
      payload: {
        items: [
          {
            skill_id: "skill-1",
            display_name: "PDF Reader",
            runtime_name: "pdf-reader",
            original_description: "Extract tables",
            translated_description: null,
            user_note: null,
            tags: ["documents"],
            license: "MIT",
            lifecycle: "Normal",
            trial_due: null,
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
        tags: ["documents"],
      },
    });

    const page = await nativeSkillLibraryFacade.listSkills(DEFAULT_SKILL_QUERY);

    expect(queryApplication).toHaveBeenCalledWith({
      type: "list_skills",
      payload: { text: "", page: 1, page_size: 25 },
    });
    expect(page.items[0]).toMatchObject({
      id: "skill-1",
      name: "PDF Reader",
      purpose: "Extract tables",
      lifecycle: "active",
      basicCheck: "not_run",
      aiCheck: "not_run",
      tags: ["documents"],
      license: "MIT",
    });
    expect(page.total).toBe(1);
    expect(page.facets.tags).toEqual(["documents"]);
  });

  it("turns an unexpected native result into the standard unavailable error", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "bootstrap_snapshot",
      payload: {
        skill_count: 0,
        project_count: 0,
        agent_count: 0,
        deployed_count: 0,
        deployment_categories: [],
        recent_operations: [],
        pending: { total: 0, by_kind: {} },
        last_scan_at: null,
        recovery_state: "clean",
      },
    });

    await expect(nativeSkillLibraryFacade.listSkills(DEFAULT_SKILL_QUERY)).rejects.toSatisfy(
      (error) => error instanceof Error && error.name === "SkillLibraryUnavailableError",
    );
  });

  it("does not silently ignore advanced filters that the native read contract does not support yet", async () => {
    vi.clearAllMocks();
    await expect(
      nativeSkillLibraryFacade.listSkills({
        ...DEFAULT_SKILL_QUERY,
        filters: { ...DEFAULT_SKILL_QUERY.filters, lifecycle: ["archived"] },
      }),
    ).rejects.toSatisfy(
      (error) => error instanceof Error && error.name === "SkillLibraryUnavailableError",
    );
    expect(queryApplication).not.toHaveBeenCalled();
  });
});
