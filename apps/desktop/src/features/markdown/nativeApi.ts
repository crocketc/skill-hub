import {
  executeCommand,
  queryApplication,
  type AppCommand,
  type AppQuery,
  type MarkdownReadOnlyReason,
  type AppQueryResult,
} from "../../api/bindings";
import {
  MarkdownUnavailableError,
  unavailableMarkdownFacade,
  type DiscardMarkdownDraftCommand,
  type MarkdownFacade,
  type ResolveLocalAssetQuery,
  type SaveMarkdownDraftCommand,
  type ValidateMarkdownCommand,
} from "./api";

function unavailableResult(): MarkdownUnavailableError {
  return new MarkdownUnavailableError();
}

/*
 * K4 待对齐（接线点）：api/bindings.ts 是生成物，尚未包含
 * save_markdown_draft / discard_markdown_draft / validate_markdown 命令与
 * markdown_issues 结果类型。这里按 api.ts 的本地契约线格式（snake_case 与
 * 后端一致）先行透传；A 侧绑定生成后，删除本桥接并改用生成的类型直接调用，
 * 命令形状与键名零改动。
 */
type PendedMarkdownCommand =
  | DiscardMarkdownDraftCommand
  | SaveMarkdownDraftCommand
  | ValidateMarkdownCommand;

// K4 待对齐（接线点）：markdown_issues 结果类型同样待生成；先以本地形状收口。
type PendedCommandResult =
  | { payload: unknown; type: "markdown_issues" }
  | { payload: unknown; type: "operation_summary" };

const executePendedCommand = (command: PendedMarkdownCommand): Promise<PendedCommandResult> =>
  executeCommand(command as unknown as AppCommand) as Promise<PendedCommandResult>;

/*
 * K9 待对齐（接线点）：resolve_local_asset 查询与 local_asset 结果类型同样
 * 待生成；先按 api.ts 的本地契约形状透传。后端未实现该查询时会在这里失败，
 * 统一折叠为不可用错误（与生成绑定落地后的行为一致）；落地后删除本桥接并
 * 改用生成的类型直接调用，形状与键名零改动。
 */
type PendedMarkdownQuery = ResolveLocalAssetQuery;

type PendedQueryResult = { payload: unknown; type: "local_asset" };

const queryPended = (query: PendedMarkdownQuery): Promise<PendedQueryResult> =>
  queryApplication(query as unknown as AppQuery) as Promise<unknown> as Promise<PendedQueryResult>;

// K4 待对齐（接线点）：生成物 MarkdownFileContent 尚无 draft / version_id 字段，
// ReadMarkdownFile 结果扩展后删除本类型并直接使用生成类型。
interface NativeMarkdownFilePayload {
  content_identity: string;
  draft?: {
    base_content_identity?: string;
    base_version_id?: string | null;
    markdown: string;
    updated_at: string;
  };
  editable: boolean;
  markdown: string;
  path: string;
  read_only_reason?: MarkdownReadOnlyReason | null;
  version_id?: string | null;
}

export const nativeMarkdownFacade: MarkdownFacade = {
  ...unavailableMarkdownFacade,
  async listMarkdownFiles(skillId) {
    try {
      const result = await queryApplication({
        type: "list_markdown_files",
        payload: { skill_id: skillId },
      });
      if (result.type !== "markdown_files") throw unavailableResult();
      return result.payload.map((file) => ({
        label: file.label,
        path: file.path,
        primary: file.primary,
      }));
    } catch {
      throw unavailableResult();
    }
  },
  async readMarkdownFile(skillId, path) {
    try {
      const result: AppQueryResult = await queryApplication({
        type: "read_markdown_file",
        payload: { skill_id: skillId, path },
      });
      if (result.type !== "markdown_file") throw unavailableResult();
      const payload = result.payload as unknown as NativeMarkdownFilePayload;
      return {
        contentIdentity: payload.content_identity,
        draft: payload.draft
          ? {
              baseContentIdentity: payload.draft.base_content_identity,
              baseVersionId: payload.draft.base_version_id,
              markdown: payload.draft.markdown,
              savedAt: payload.draft.updated_at,
            }
          : undefined,
        editable: payload.editable,
        markdown: payload.markdown,
        path: payload.path,
        // QA-013：只读原因来自领域所有权矩阵，前端不伪造所有权。
        readOnlyReason: payload.read_only_reason ?? undefined,
        versionId: payload.version_id ?? undefined,
      };
    } catch {
      throw unavailableResult();
    }
  },
  async saveSkillContent(skillId, path, markdown, expectedIdentity) {
    const result = await executeCommand({
      type: "save_markdown_content",
      payload: {
        skill_id: skillId,
        path,
        markdown,
        expected_identity: expectedIdentity,
      },
    });
    if (result.type !== "saved_skill_content") throw unavailableResult();
    return {
      contentIdentity: result.payload.content_identity,
      newVersionId: result.payload.version_id,
    };
  },
  async saveMarkdownAsCopy(skillId, path, markdown, expectedIdentity) {
    const result = await executeCommand({
      type: "save_markdown_as_copy",
      payload: {
        skill_id: skillId,
        path,
        markdown,
        expected_identity: expectedIdentity,
      },
    });
    if (result.type !== "saved_skill_content") throw unavailableResult();
  },
  async saveDraft(skillId, path, markdown, base) {
    const result = await executePendedCommand({
      payload: {
        base_content_identity: base.contentIdentity,
        base_version_id: base.versionId,
        markdown,
        path,
        skill_id: skillId,
      },
      type: "save_markdown_draft",
    });
    if (result.type !== "operation_summary") throw unavailableResult();
  },
  async discardDraft(skillId, path) {
    const result = await executePendedCommand({
      payload: { skill_id: skillId, path },
      type: "discard_markdown_draft",
    });
    if (result.type !== "operation_summary") throw unavailableResult();
  },
  async validateMarkdown(path, markdown) {
    const result = await executePendedCommand({
      payload: { markdown, path },
      type: "validate_markdown",
    });
    if (result.type !== "markdown_issues") throw unavailableResult();
    const payload = result.payload;
    if (!Array.isArray(payload)) throw unavailableResult();
    // 确定性校验结果：只做形状收口，不做 LLM 兜底或结果伪造。
    return payload.map((entry) => {
      const issue = entry as {
        code?: unknown;
        line?: unknown;
        message?: unknown;
        severity?: unknown;
      };
      if (typeof issue.code !== "string" || typeof issue.message !== "string") {
        throw unavailableResult();
      }
      return {
        code: issue.code,
        line: typeof issue.line === "number" ? issue.line : undefined,
        message: issue.message,
        severity: issue.severity === "warning" ? ("warning" as const) : ("error" as const),
      };
    });
  },
  async openExternalUrl(target: string) {
    try {
      const result = await executeCommand({
        type: "open_external_url",
        payload: { url: target },
      });
      if (result.type !== "operation_summary") throw unavailableResult();
    } catch (error) {
      throw error instanceof Error ? error : unavailableResult();
    }
  },
  async resolveLocalAsset(skillId, markdownPath, assetPath, versionId) {
    try {
      const result = await queryPended({
        payload: {
          asset_path: assetPath,
          markdown_path: markdownPath,
          skill_id: skillId,
          // 缺省（含调用方未知版本身份）交给后端解析当前版本；历史读取显式传入。
          version_id: versionId ?? null,
        },
        type: "resolve_local_asset",
      });
      if (result.type !== "local_asset") throw unavailableResult();
      const payload = result.payload as { url?: unknown } | null;
      if (!payload || typeof payload.url !== "string" || !payload.url) {
        throw unavailableResult();
      }
      return payload.url;
    } catch {
      // 后端查询未落地或解析失败（缺失/越界/权限）时如实不可用，
      // 由渲染层以可读说明收尾，不伪造本地路径。
      throw unavailableResult();
    }
  },
};
