import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { MarkdownUnavailableError } from "./api";
import { nativeMarkdownFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));

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

  it("maps Markdown content with its native editability", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "markdown_file",
      payload: {
        content_identity: "sha256:abc",
        editable: true,
        markdown: "# Preview",
        path: "SKILL.md",
      },
    });
    await expect(nativeMarkdownFacade.readMarkdownFile("skill-1", "SKILL.md")).resolves.toEqual({
      contentIdentity: "sha256:abc",
      editable: true,
      markdown: "# Preview",
      path: "SKILL.md",
    });
  });

  it("saves Markdown through the versioned native command", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "saved_skill_content",
      payload: {
        skill_id: "skill-1",
        path: "SKILL.md",
        version_id: "sha256:version-2",
        content_identity: "sha256:content-2",
      },
    });

    await expect(nativeMarkdownFacade.saveSkillContent(
      "skill-1",
      "SKILL.md",
      "# Updated",
      "sha256:content-1",
    )).resolves.toEqual({
      contentIdentity: "sha256:content-2",
      newVersionId: "sha256:version-2",
    });
    expect(executeCommand).toHaveBeenCalledWith({
      type: "save_markdown_content",
      payload: {
        skill_id: "skill-1",
        path: "SKILL.md",
        markdown: "# Updated",
        expected_identity: "sha256:content-1",
      },
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

  it("opens a link through the native external opener", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: {
        operation_id: "op-1",
        phase: "committed",
        message_code: "external_link.opened",
        error_code: null,
      },
    });

    await expect(
      nativeMarkdownFacade.openExternalUrl("https://github.com/anthropics/skills"),
    ).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "open_external_url",
      payload: { url: "https://github.com/anthropics/skills" },
    });
  });

  it("rejects when the native layer refuses the link", async () => {
    vi.mocked(executeCommand).mockRejectedValue({ code: "input.invalid" });

    await expect(
      nativeMarkdownFacade.openExternalUrl("https://example.com/readme"),
    ).rejects.toBeTruthy();
  });
});
