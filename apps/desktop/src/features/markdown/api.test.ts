import { describe, expect, it } from "vitest";
import {
  MarkdownNotFoundError,
  MarkdownUnavailableError,
  unavailableMarkdownFacade,
} from "./api";
import { createMockMarkdownFacade } from "./testFixtures";

describe("MarkdownFacade contract", () => {
  it("keeps production-unavailable distinct from a missing file", async () => {
    await expect(
      unavailableMarkdownFacade.listMarkdownFiles("pdf-reader"),
    ).rejects.toBeInstanceOf(MarkdownUnavailableError);

    const missing = createMockMarkdownFacade({ missingFile: true });
    await expect(
      missing.readMarkdownFile("pdf-reader", "missing.md"),
    ).rejects.toBeInstanceOf(MarkdownNotFoundError);
  });

  it("stores a local draft without changing formal Markdown", async () => {
    const facade = createMockMarkdownFacade();
    const original = await facade.readMarkdownFile("pdf-reader", "SKILL.md");

    await facade.saveDraft("pdf-reader", "SKILL.md", "# Draft");

    const current = await facade.readMarkdownFile("pdf-reader", "SKILL.md");
    expect(current.markdown).toBe(original.markdown);
    expect(current.draft?.markdown).toBe("# Draft");
    expect(facade.calls.savedVersions).toEqual([]);
  });

  // K4 契约：草稿查询与读取结果共用同一份草稿事实；无草稿时如实为 null。
  it("answers the draft query with the stored draft facts or null", async () => {
    const facade = createMockMarkdownFacade();

    await expect(
      facade.getDraft("pdf-reader", "SKILL.md"),
    ).resolves.toBeNull();

    await facade.saveDraft("pdf-reader", "SKILL.md", "# Queried draft", {
      contentIdentity: "sha256:skill-md-v1",
      versionId: "v1",
    });

    await expect(
      facade.getDraft("pdf-reader", "SKILL.md"),
    ).resolves.toEqual({
      baseContentIdentity: "sha256:skill-md-v1",
      baseVersionId: "v1",
      markdown: "# Queried draft",
      savedAt: "2026-08-26T12:00:00Z",
    });
  });
});
