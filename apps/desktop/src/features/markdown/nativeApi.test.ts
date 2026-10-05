import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import type { SaveMarkdownAsCopy } from "../../api/bindings";
import { MarkdownUnavailableError } from "./api";
import { nativeMarkdownFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));

/** K5 目标契约：save_markdown_as_copy 改为整体请求对象（GREEN 前生产签名未到位）。 */
function saveCopyRequest(facade: object, request: SaveMarkdownAsCopy): Promise<unknown> {
  return (facade as unknown as {
    saveMarkdownAsCopy: (request: SaveMarkdownAsCopy) => Promise<unknown>;
  }).saveMarkdownAsCopy(request);
}

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

  // K5：另存副本命令承载来源血缘与继承选择；回执是统一 saved_skill_copy。
  it("saves Markdown as a copy with origin and inheritance through the native command", async () => {
    const payload = {
      skill_id: "skill-1",
      path: "SKILL.md",
      markdown: "# Copy",
      expected_identity: "sha256:content-1",
      origin: { source_skill_id: "skill-1", source_version_id: "sha256:version-1" },
      inheritance: "None" as const,
    };
    vi.mocked(executeCommand).mockResolvedValue({
      type: "saved_skill_copy",
      payload: {
        content_identity: "sha256:copy-content",
        display_name: "PDF Reader copy",
        inheritance: "NotRequested",
        lineage_registered: true,
        path: "SKILL.md",
        recovery_operation_id: null,
        skill_id: "skill-copy",
        version_id: "sha256:copy-version",
      },
    });

    await expect(saveCopyRequest(nativeMarkdownFacade, payload)).resolves.toEqual({
      content_identity: "sha256:copy-content",
      display_name: "PDF Reader copy",
      inheritance: "NotRequested",
      lineage_registered: true,
      path: "SKILL.md",
      recovery_operation_id: null,
      skill_id: "skill-copy",
      version_id: "sha256:copy-version",
    });
    expect(executeCommand).toHaveBeenCalledWith({
      type: "save_markdown_as_copy",
      payload,
    });
  });

  // K5：回执守卫收紧为 saved_skill_copy；旧 saved_skill_content 不再被接受。
  it("rejects a save_markdown_as_copy receipt without the unified copy outcome", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "saved_skill_content",
      payload: {
        skill_id: "skill-copy",
        path: "SKILL.md",
        version_id: "sha256:copy-version",
        content_identity: "sha256:copy-content",
      },
    });

    await expect(saveCopyRequest(nativeMarkdownFacade, {
      skill_id: "skill-1",
      path: "SKILL.md",
      markdown: "# Copy",
      expected_identity: "sha256:content-1",
    })).rejects.toBeInstanceOf(MarkdownUnavailableError);
  });

  // K5：替换继承预览走真实查询绑定，逐目标事实原样透传。
  it("queries the takeover replacement preview through the native binding", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "save_as_copy_replacement_preview",
      payload: {
        confirmation_fingerprint: "fp-1",
        expires_at: "2026-10-04T12:00:00Z",
        preview_id: "preview-1",
        source_skill_id: "skill-1",
        source_version_id: "sha256:version-1",
        targets: [
          {
            blocker: null,
            consumer_deployment_ids: ["dep-1"],
            deployment_id: "dep-1",
            managed: true,
            path: "C:/Agents/Codex/skills/pdf-reader",
            requires_shared_target_confirmation: false,
            runtime_name: "pdf-reader",
            target_id: "tgt-1",
            version_id: "sha256:version-1",
          },
        ],
      },
    });

    await expect((nativeMarkdownFacade as unknown as {
      saveAsCopyReplacementPreview: (skillId: string, targets: string[]) => Promise<unknown>;
    }).saveAsCopyReplacementPreview("skill-1", ["dep-1"])).resolves.toMatchObject({
      preview_id: "preview-1",
    });
    expect(queryApplication).toHaveBeenCalledWith({
      type: "get_save_as_copy_replacement_preview",
      payload: { source_skill_id: "skill-1", targets: ["dep-1"] },
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

  // K9 契约：本地资源解析走真实生成查询绑定，内容以 data URL 承载，
  // 缺省 version_id 传 null（由后端解析当前版本）。
  it("resolves a local asset through the native query and returns the data URL", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "local_asset",
      payload: {
        skill_id: "skill-1",
        version_id: "v7",
        markdown_path: "SKILL.md",
        asset_path: "assets/flow.png",
        media_type: "image/png",
        data_url: "data:image/png;base64,AAAA",
      },
    } as never);

    await expect(
      nativeMarkdownFacade.resolveLocalAsset("skill-1", "SKILL.md", "assets/flow.png", "v7"),
    ).resolves.toBe("data:image/png;base64,AAAA");
    expect(queryApplication).toHaveBeenCalledWith({
      type: "resolve_local_asset",
      payload: {
        skill_id: "skill-1",
        markdown_path: "SKILL.md",
        asset_path: "assets/flow.png",
        version_id: "v7",
      },
    });
  });

  it("resolves a current-version asset with a null version id", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "local_asset",
      payload: {
        skill_id: "skill-1",
        version_id: "v7",
        markdown_path: "SKILL.md",
        asset_path: "assets/flow.png",
        media_type: "image/png",
        data_url: "data:image/png;base64,AAAA",
      },
    } as never);

    await expect(
      nativeMarkdownFacade.resolveLocalAsset("skill-1", "SKILL.md", "assets/flow.png"),
    ).resolves.toBe("data:image/png;base64,AAAA");
    expect(queryApplication).toHaveBeenCalledWith({
      type: "resolve_local_asset",
      payload: {
        skill_id: "skill-1",
        markdown_path: "SKILL.md",
        asset_path: "assets/flow.png",
        version_id: null,
      },
    });
  });

  it("keeps a malformed local-asset answer unavailable instead of faking a URL", async () => {
    vi.mocked(queryApplication).mockResolvedValue({
      type: "local_asset",
      payload: {
        skill_id: "skill-1",
        version_id: "v7",
        markdown_path: "SKILL.md",
        asset_path: "assets/flow.png",
        media_type: "image/png",
        data_url: "",
      },
    } as never);

    await expect(
      nativeMarkdownFacade.resolveLocalAsset("skill-1", "SKILL.md", "assets/flow.png", "v7"),
    ).rejects.toBeInstanceOf(MarkdownUnavailableError);
  });

  // K9 契约：三个本地打开命令走真实生成命令绑定，回执是 operation_summary。
  it("opens a file with the default application through the native command", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: {
        operation_id: "op-open-1",
        phase: "committed",
        message_code: "local_open.opened",
        error_code: null,
      },
    });

    await expect(
      nativeMarkdownFacade.openDefaultApplication("skill-1", "C:/library/pdf-reader/SKILL.md"),
    ).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "open_default_application",
      payload: { skill_id: "skill-1", path: "C:/library/pdf-reader/SKILL.md" },
    });
  });

  it("reveals the skill folder through the native command with its own path", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: {
        operation_id: "op-open-2",
        phase: "committed",
        message_code: "local_open.opened",
        error_code: null,
      },
    });

    await expect(
      nativeMarkdownFacade.openSkillFolder("skill-1", "C:/library/pdf-reader"),
    ).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "open_skill_folder",
      payload: { skill_id: "skill-1", path: "C:/library/pdf-reader" },
    });
  });

  it("offers the platform application chooser through the native command", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "operation_summary",
      payload: {
        operation_id: "op-open-3",
        phase: "committed",
        message_code: "local_open.opened",
        error_code: null,
      },
    });

    await expect(
      nativeMarkdownFacade.chooseExternalApplication("skill-1", "C:/library/pdf-reader/SKILL.md"),
    ).resolves.toBeUndefined();
    expect(executeCommand).toHaveBeenCalledWith({
      type: "choose_external_application",
      payload: { skill_id: "skill-1", path: "C:/library/pdf-reader/SKILL.md" },
    });
  });

  it("refuses an open answered by an unrelated result type", async () => {
    vi.mocked(executeCommand).mockResolvedValue({
      type: "saved_skill_content",
      payload: {
        skill_id: "skill-1",
        path: "SKILL.md",
        version_id: "v7",
        content_identity: "sha256:abc",
      },
    } as never);

    await expect(
      nativeMarkdownFacade.openDefaultApplication("skill-1", "C:/library/pdf-reader/SKILL.md"),
    ).rejects.toBeInstanceOf(MarkdownUnavailableError);
  });
});
