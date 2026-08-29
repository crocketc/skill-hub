import { describe, expect, it, vi } from "vitest";
import { queryApplication } from "../../api/bindings";
import { nativeSkillDetailFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({
  queryApplication: vi.fn(),
}));

describe("native skill detail facade", () => {
  it("maps the native skill projection to summary and metadata", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "skill",
      payload: {
        skill_id: "skill-1",
        display_name: "PDF Reader",
        runtime_name: "pdf-reader",
        original_description: "Extract tables",
        translated_description: "提取表格",
        user_note: "Review before deployment",
        tags: ["documents", "pdf"],
        license: "MIT",
        lifecycle: "Normal",
        trial_due: "2026-09-15",
      },
    });

    await expect(nativeSkillDetailFacade.getSummary("skill-1")).resolves.toMatchObject({
      id: "skill-1",
      name: "PDF Reader",
      purpose: "提取表格",
      lifecycle: "trial",
      trialDue: "2026-09-15",
    });
    await expect(nativeSkillDetailFacade.getMetadata("skill-1")).resolves.toMatchObject({
      originalDescription: "Extract tables",
      purpose: "提取表格",
      note: "Review before deployment",
      tags: ["documents", "pdf"],
      license: "MIT",
    });
    expect(queryApplication).toHaveBeenCalledTimes(2);
  });

  it("turns an unexpected native result into the standard unavailable error", async () => {
    vi.clearAllMocks();
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

    await expect(nativeSkillDetailFacade.getSummary("skill-1")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error && error.name === "SkillDetailUnavailableError",
    );
  });
});
