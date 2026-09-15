import { describe, expect, it } from "vitest";
import {
  SkillDetailNotFoundError,
  SkillDetailUnavailableError,
  skillDetailKeys,
  unavailableSkillDetailFacade,
} from "./api";

describe("Skill detail contracts", () => {
  it("creates stable panel-specific query keys", () => {
    expect(skillDetailKeys.summary("skill-pdf")).toEqual([
      "skill-detail",
      "skill-pdf",
      "summary",
    ]);
    expect(skillDetailKeys.versions("skill-pdf")).toEqual([
      "skill-detail",
      "skill-pdf",
      "versions",
    ]);
  });

  it("rejects production detail queries without returning demo data", async () => {
    await expect(
      unavailableSkillDetailFacade.getSummary("skill-pdf"),
    ).rejects.toBeInstanceOf(SkillDetailUnavailableError);
    await expect(
      unavailableSkillDetailFacade.getVersions("skill-pdf"),
    ).rejects.toBeInstanceOf(SkillDetailUnavailableError);
    // Task 7：关系概览与移除影响在无原生契约时同样诚实不可用。
    await expect(
      unavailableSkillDetailFacade.getRelationshipOverview("skill-pdf"),
    ).rejects.toBeInstanceOf(SkillDetailUnavailableError);
    await expect(
      unavailableSkillDetailFacade.getRelationshipRemovalImpact("rel-1"),
    ).rejects.toBeInstanceOf(SkillDetailUnavailableError);
  });

  it("keeps missing objects distinct from an unavailable production contract", () => {
    expect(new SkillDetailNotFoundError("missing")).not.toBeInstanceOf(
      SkillDetailUnavailableError,
    );
  });
});
