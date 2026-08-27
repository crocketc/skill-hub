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
});
