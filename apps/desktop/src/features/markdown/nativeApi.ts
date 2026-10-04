import {
  executeCommand,
  queryApplication,
  type AppQuery,
  type MarkdownDraftSummary,
  type MarkdownFileContent,
  type AppQueryResult,
} from "../../api/bindings";
import {
  MarkdownUnavailableError,
  unavailableMarkdownFacade,
  type MarkdownDraft,
  type MarkdownFacade,
  type ResolveLocalAssetQuery,
} from "./api";

function unavailableResult(): MarkdownUnavailableError {
  return new MarkdownUnavailableError();
}

/*
 * K4 契约对齐：save/discard/validate 三条命令与 get_markdown_draft 查询已由
 * 生成绑定承载，直接走真实 executeCommand/queryApplication，结果守卫按真实
 * 回执类型（markdown_draft_saved / markdown_draft_discarded /
 * markdown_validation_result / markdown_draft）收口。
 */

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

// K9 待对齐（接线点）：生成物 MarkdownFileContent 已含 K4 草稿摘要，尚缺
// version_id 字段；本地仅扩展版本身份，其余直接消费生成类型。
type NativeMarkdownFilePayload = MarkdownFileContent & {
  version_id?: string | null;
};

/** 把线格式草稿摘要映射为领域视图；无草稿时如实为 null，不伪造空草稿。 */
const toDomainDraft = (
  summary: MarkdownDraftSummary | null | undefined,
): MarkdownDraft | null =>
  summary
    ? {
        baseContentIdentity: summary.base_content_identity,
        baseVersionId: summary.base_version_id,
        markdown: summary.markdown,
        savedAt: summary.updated_at,
      }
    : null;

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
        draft: toDomainDraft(payload.draft) ?? undefined,
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
    // K4：结果守卫是草稿回执 markdown_draft_saved（载荷 skill_id/path/updated_at
    // 由调用方已知，仅作类型收口），不再是通用 operation_summary。
    const result = await executeCommand({
      payload: {
        base_content_identity: base.contentIdentity,
        base_version_id: base.versionId,
        markdown,
        path,
        skill_id: skillId,
      },
      type: "save_markdown_draft",
    });
    if (result.type !== "markdown_draft_saved") throw unavailableResult();
  },
  async discardDraft(skillId, path) {
    // K4：丢弃是幂等命令，成功同形回执 markdown_draft_discarded。
    const result = await executeCommand({
      payload: { skill_id: skillId, path },
      type: "discard_markdown_draft",
    });
    if (result.type !== "markdown_draft_discarded") throw unavailableResult();
  },
  async getDraft(skillId, path) {
    try {
      // K4：草稿查询走真实查询绑定；无草稿时载荷为 null，如实返回。
      const result: AppQueryResult = await queryApplication({
        payload: { skill_id: skillId, path },
        type: "get_markdown_draft",
      });
      if (result.type !== "markdown_draft") throw unavailableResult();
      return toDomainDraft(result.payload);
    } catch {
      throw unavailableResult();
    }
  },
  async validateMarkdown(path, markdown) {
    // K4：确定性校验总是成功返回；问题只有 code+field+params（无行号、
    // 无严重性），这里只做结果类型守卫，不补写后端没有给出的字段。
    const result = await executeCommand({
      payload: { markdown, path },
      type: "validate_markdown",
    });
    if (result.type !== "markdown_validation_result") throw unavailableResult();
    return result.payload.issues;
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
