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
        read_only_reason: null,
      },
    });
    await expect(nativeMarkdownFacade.readMarkdownFile("skill-1", "SKILL.md")).resolves.toEqual({
      contentIdentity: "sha256:abc",
      editable: true,
      markdown: "# Preview",
      path: "SKILL.md",
      // QA-013：托管副本没有只读原因，前端不伪造所有权。
      readOnlyReason: undefined,
    });
  });

  it("maps the domain read-only reason so ownership drives the editor", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "markdown_file",
      payload: {
        content_identity: "sha256:def",
        editable: false,
        markdown: "# External",
        path: "SKILL.md",
        read_only_reason: "external",
      },
    });
    await expect(nativeMarkdownFacade.readMarkdownFile("skill-1", "SKILL.md")).resolves.toEqual({
      contentIdentity: "sha256:def",
      editable: false,
      markdown: "# External",
      path: "SKILL.md",
      readOnlyReason: "external",
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

  it("saves Markdown as a copy through the native command", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "saved_skill_content",
      payload: {
        skill_id: "skill-copy",
        path: "SKILL.md",
        version_id: "sha256:copy-version",
        content_identity: "sha256:copy-content",
      },
    });

    await expect(nativeMarkdownFacade.saveMarkdownAsCopy(
      "skill-1",
      "SKILL.md",
      "# Copy",
      "sha256:content-1",
    )).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "save_markdown_as_copy",
      payload: {
        skill_id: "skill-1",
        path: "SKILL.md",
        markdown: "# Copy",
        expected_identity: "sha256:content-1",
      },
    });
  });

  // K4 契约：草稿保存走真实生成绑定，结果守卫是 markdown_draft_saved 回执。
  it("saves the local draft with base metadata through the native command", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "markdown_draft_saved",
      payload: {
        skill_id: "skill-1",
        path: "SKILL.md",
        updated_at: "2026-10-04T08:00:00Z",
      },
    });

    await expect(
      nativeMarkdownFacade.saveDraft("skill-1", "SKILL.md", "# Draft", {
        contentIdentity: "sha256:abc",
        versionId: null,
      }),
    ).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "save_markdown_draft",
      payload: {
        skill_id: "skill-1",
        path: "SKILL.md",
        markdown: "# Draft",
        base_version_id: null,
        base_content_identity: "sha256:abc",
      },
    });
  });

  it("rejects a draft save answered by an unrelated result type", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: {
        operation_id: "op-draft-1",
        phase: "committed",
        message_code: "markdown_draft.saved",
        error_code: null,
      },
    });

    await expect(
      nativeMarkdownFacade.saveDraft("skill-1", "SKILL.md", "# Draft", {
        contentIdentity: "sha256:abc",
        versionId: null,
      }),
    ).rejects.toBeInstanceOf(MarkdownUnavailableError);
  });

  // K4 契约：草稿丢弃的回执是 markdown_draft_discarded（幂等成功同形）。
  it("discards the local draft through the native command", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "markdown_draft_discarded",
      payload: { skill_id: "skill-1", path: "SKILL.md" },
    });

    await expect(
      nativeMarkdownFacade.discardDraft("skill-1", "SKILL.md"),
    ).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "discard_markdown_draft",
      payload: { skill_id: "skill-1", path: "SKILL.md" },
    });
  });

  // K4 契约：校验结果没有行号与严重性，只有稳定机器码 + 违规字段 + 确定性参数。
  it("validates Markdown through the deterministic native command", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "markdown_validation_result",
      payload: {
        valid: false,
        issues: [
          {
            code: "markdown_too_large",
            field: "markdown",
            params: { size: "2097152", size_limit: "1048576" },
          },
        ],
      },
    });

    await expect(
      nativeMarkdownFacade.validateMarkdown("SKILL.md", "# Draft"),
    ).resolves.toEqual([
      {
        code: "markdown_too_large",
        field: "markdown",
        params: { size: "2097152", size_limit: "1048576" },
      },
    ]);
    expect(executeCommand).toHaveBeenCalledWith({
      type: "validate_markdown",
      payload: { path: "SKILL.md", markdown: "# Draft" },
    });
  });

  // K4 契约：草稿查询走真实查询绑定；无草稿时载荷为 null。
  it("queries the native draft summary and maps it onto the domain draft", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "markdown_draft",
      payload: {
        base_content_identity: "sha256:abc",
        base_version_id: "v7",
        markdown: "# Draft",
        updated_at: "2026-10-04T08:00:00Z",
      },
    });

    await expect(
      nativeMarkdownFacade.getDraft("skill-1", "SKILL.md"),
    ).resolves.toEqual({
      baseContentIdentity: "sha256:abc",
      baseVersionId: "v7",
      markdown: "# Draft",
      savedAt: "2026-10-04T08:00:00Z",
    });
    expect(queryApplication).toHaveBeenCalledWith({
      type: "get_markdown_draft",
      payload: { skill_id: "skill-1", path: "SKILL.md" },
    });
  });

  it("answers the draft query with null when no draft exists", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "markdown_draft",
      payload: null,
    });

    await expect(
      nativeMarkdownFacade.getDraft("skill-1", "SKILL.md"),
    ).resolves.toBeNull();
  });

  it("maps the native draft summary and base metadata onto the file content", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "markdown_file",
      payload: {
        content_identity: "sha256:abc",
        editable: true,
        markdown: "# Base",
        path: "SKILL.md",
        read_only_reason: null,
        version_id: "v7",
        draft: {
          markdown: "# Draft",
          base_version_id: "v7",
          base_content_identity: "sha256:abc",
          updated_at: "2026-09-30T10:00:00Z",
        },
      },
    } as never);

    await expect(nativeMarkdownFacade.readMarkdownFile("skill-1", "SKILL.md")).resolves.toEqual({
      contentIdentity: "sha256:abc",
      editable: true,
      markdown: "# Base",
      path: "SKILL.md",
      readOnlyReason: undefined,
      versionId: "v7",
      draft: {
        markdown: "# Draft",
        savedAt: "2026-09-30T10:00:00Z",
        baseVersionId: "v7",
        baseContentIdentity: "sha256:abc",
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
