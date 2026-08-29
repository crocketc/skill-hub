import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryApplication } from "../../api/bindings";
import { MarkdownUnavailableError } from "./api";
import { nativeMarkdownFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({ queryApplication: vi.fn() }));

describe("nativeMarkdownFacade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps the immutable Markdown file list", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "markdown_files",
      payload: [{ label: "SKILL.md", path: "SKILL.md", primary: true }],
    });
    await expect(nativeMarkdownFacade.listMarkdownFiles("skill-1")).resolves.toEqual([
      { label: "SKILL.md", path: "SKILL.md", primary: true },
    ]);
    expect(queryApplication).toHaveBeenCalledWith({
      type: "list_markdown_files",
      payload: { skill_id: "skill-1" },
    });
  });

  it("maps Markdown content as read-only", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "markdown_file",
      payload: {
        content_identity: "sha256:abc",
        editable: false,
        markdown: "# Preview",
        path: "SKILL.md",
      },
    });
    await expect(nativeMarkdownFacade.readMarkdownFile("skill-1", "SKILL.md")).resolves.toEqual({
      contentIdentity: "sha256:abc",
      editable: false,
      markdown: "# Preview",
      path: "SKILL.md",
    });
  });

  it("keeps unexpected production results unavailable", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "bootstrap_snapshot",
      payload: {},
    } as never);
    await expect(nativeMarkdownFacade.listMarkdownFiles("skill-1")).rejects.toBeInstanceOf(
      MarkdownUnavailableError,
    );
  });
});
