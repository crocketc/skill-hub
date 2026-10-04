export interface MarkdownFileEntry {
  label: string;
  path: string;
  primary: boolean;
}

export interface MarkdownDraft {
  /** 草稿创建时的基准内容身份；后端据此判断草稿是否仍可套用到当前文件。 */
  baseContentIdentity?: string;
  /** 草稿创建时的基准版本；本地读取可能缺失（旧草稿），保持可空。 */
  baseVersionId?: string | null;
  markdown: string;
  savedAt: string;
}

/** 编辑起点元数据：草稿保存时必须上报，后端据此记录草稿基准。 */
export interface MarkdownDraftBase {
  contentIdentity: string;
  versionId: string | null;
}

export type MarkdownReadOnlyReason =
  | "builtin"
  | "external"
  | "permission"
  | "plugin";

export interface MarkdownFileContent {
  contentIdentity: string;
  draft?: MarkdownDraft;
  editable: boolean;
  markdown: string;
  path: string;
  readOnlyReason?: MarkdownReadOnlyReason;
  /** 当前内容所属版本；本地线格式可能缺失，缺省时草稿基准只记内容身份。 */
  versionId?: string;
}

export interface MarkdownValidationIssue {
  code: string;
  line?: number;
  message: string;
  severity: "error" | "warning";
}

export interface MarkdownSaveResult {
  contentIdentity: string;
  newVersionId: string;
}

/*
 * K4 契约线格式（snake_case，键名与后端命令一一对应）。
 * api/bindings.ts 是生成物，尚未包含 K4 草稿/校验命令；这里先行声明本地
 * 类型，A 侧绑定生成后按同名形状对齐，nativeApi 透传处零改动替换。
 */
export interface SaveMarkdownDraftCommand {
  type: "save_markdown_draft";
  payload: {
    base_content_identity: string;
    base_version_id: string | null;
    markdown: string;
    path: string;
    skill_id: string;
  };
}

export interface DiscardMarkdownDraftCommand {
  type: "discard_markdown_draft";
  payload: {
    path: string;
    skill_id: string;
  };
}

export interface GetMarkdownDraftCommand {
  type: "get_markdown_draft";
  payload: {
    path: string;
    skill_id: string;
  };
}

export interface ValidateMarkdownCommand {
  type: "validate_markdown";
  payload: {
    markdown: string;
    path: string;
  };
}

/** ReadMarkdownFile 结果中的草稿摘要（含草稿基准元数据）。 */
export interface MarkdownDraftSummaryPayload {
  base_content_identity: string;
  base_version_id: string | null;
  markdown: string;
  updated_at: string;
}

export interface MarkdownFacade {
  chooseExternalApplication(skillId: string, path: string): Promise<void>;
  discardDraft(skillId: string, path: string): Promise<void>;
  listMarkdownFiles(skillId: string): Promise<MarkdownFileEntry[]>;
  openDefaultApplication(skillId: string, path: string): Promise<void>;
  openExternalUrl(target: string): Promise<void>;
  openSkillFolder(skillId: string): Promise<void>;
  readMarkdownFile(skillId: string, path: string): Promise<MarkdownFileContent>;
  requestTakeover(skillId: string): Promise<void>;
  resolveLocalAsset(
    skillId: string,
    markdownPath: string,
    assetPath: string,
  ): Promise<string>;
  saveDraft(
    skillId: string,
    path: string,
    markdown: string,
    base: MarkdownDraftBase,
  ): Promise<void>;
  saveMarkdownAsCopy(
    skillId: string,
    path: string,
    markdown: string,
    expectedIdentity: string,
  ): Promise<void>;
  saveSkillContent(
    skillId: string,
    path: string,
    markdown: string,
    expectedIdentity: string,
  ): Promise<MarkdownSaveResult>;
  /** 确定性校验（路径合法、1 MiB 上限、非空），与 LLM 无关。 */
  validateMarkdown(path: string, markdown: string): Promise<MarkdownValidationIssue[]>;
}

export class MarkdownUnavailableError extends Error {
  constructor() {
    super("The Markdown production contract is unavailable.");
    this.name = "MarkdownUnavailableError";
  }
}

export class MarkdownNotFoundError extends Error {
  constructor(path: string) {
    super(`Markdown file not found: ${path}`);
    this.name = "MarkdownNotFoundError";
  }
}

export class MarkdownContentConflictError extends Error {
  constructor(path: string) {
    super(`Markdown content changed outside the editor: ${path}`);
    this.name = "MarkdownContentConflictError";
  }
}

const unavailable = (): Promise<never> =>
  Promise.reject(new MarkdownUnavailableError());

export const unavailableMarkdownFacade: MarkdownFacade = {
  chooseExternalApplication: unavailable,
  discardDraft: unavailable,
  listMarkdownFiles: unavailable,
  openDefaultApplication: unavailable,
  openExternalUrl: unavailable,
  openSkillFolder: unavailable,
  readMarkdownFile: unavailable,
  requestTakeover: unavailable,
  resolveLocalAsset: unavailable,
  saveDraft: unavailable,
  saveMarkdownAsCopy: unavailable,
  saveSkillContent: unavailable,
  validateMarkdown: unavailable,
};

const markdownKey = (skillId: string) => ["skill-markdown", skillId] as const;

export const markdownKeys = {
  files: (skillId: string) => [...markdownKey(skillId), "files"] as const,
  file: (skillId: string, path: string) =>
    [...markdownKey(skillId), "file", path] as const,
  root: ["skill-markdown"] as const,
  skill: markdownKey,
};
