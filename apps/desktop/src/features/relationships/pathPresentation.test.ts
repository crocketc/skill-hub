import { describe, expect, it } from "vitest";
import { presentRelationshipPath } from "./pathPresentation";

describe("presentRelationshipPath", () => {
  it("normalizes mixed separators and keeps a short path intact", () => {
    expect(presentRelationshipPath("C:/agents\\codex/skills/pdf-reader")).toEqual({
      fullPath: "C:\\agents\\codex\\skills\\pdf-reader",
      label: "C:\\agents\\codex\\skills\\pdf-reader",
    });
  });

  it("elides leading directories while preserving the normalized full path", () => {
    const presentation = presentRelationshipPath(
      "\\\\?\\C:\\Users\\profile\\AppData\\Local\\SkillHub\\agents\\codex\\skills\\pdf-reader",
      36,
    );

    expect(presentation.fullPath).toBe(
      "C:\\Users\\profile\\AppData\\Local\\SkillHub\\agents\\codex\\skills\\pdf-reader",
    );
    expect(presentation.label).toBe("…\\codex\\skills\\pdf-reader");
    expect(presentation.label.length).toBeLessThanOrEqual(36);
  });

  it("keeps a long final name bounded even when it exceeds the label limit", () => {
    const presentation = presentRelationshipPath(
      "/opt/skillhub/agents/very-long-directory-name-that-cannot-fit",
      20,
    );

    expect(presentation.label.startsWith("…/")).toBe(true);
    expect(presentation.label.length).toBeLessThanOrEqual(20);
    expect(presentation.fullPath).toBe("/opt/skillhub/agents/very-long-directory-name-that-cannot-fit");
  });
});
