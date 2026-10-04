/*
 * K4 契约对齐：校验问题直接消费生成绑定里的线格式——只有稳定机器码、
 * 违规字段与确定性参数，没有行号与严重性；用户事实文案由展示层按
 * code+field+params 映射，这里不做二次形状。
 */
import type { MarkdownValidationIssue } from "../../api/bindings";

export type { MarkdownValidationIssue };

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

export interface MarkdownSaveResult {
  contentIdentity: string;
  newVersionId: string;
}

/*
 * K9 契约对齐：本地资源解析查询与三个本地打开命令都由生成绑定承载
 * （resolve_local_asset 查询 / open_default_application、open_skill_folder、
 * choose_external_application 命令），nativeApi 直接调用真实绑定。
 */

/**
 * 把可见树根（SkillResult.root_path）与树内相对路径拼成打开命令所需的
 * 绝对路径；后端按规范身份校验路径确实落在该 Skill 的物化树内。
 */
export function joinSkillTreePath(rootPath: string, relativePath: string): string {
  const root = rootPath.replace(/[\\/]+$/, "");
  const relative = relativePath.replace(/^[\\/]+/, "");
  return `${root}/${relative}`;
}

export interface MarkdownFacade {
  chooseExternalApplication(skillId: string, path: string): Promise<void>;
  discardDraft(skillId: string, path: string): Promise<void>;
  /** K4：单文件草稿查询；无草稿时如实为 null，不伪造空草稿。 */
  getDraft(skillId: string, path: string): Promise<MarkdownDraft | null>;
  listMarkdownFiles(skillId: string): Promise<MarkdownFileEntry[]>;
  openDefaultApplication(skillId: string, path: string): Promise<void>;
  openExternalUrl(target: string): Promise<void>;
  /** 打开 Skill 可见树内的一个目录；路径必须是树内绝对路径。 */
  openSkillFolder(skillId: string, path: string): Promise<void>;
  readMarkdownFile(skillId: string, path: string): Promise<MarkdownFileContent>;
  /**
   * K9：解析 Markdown 内的本地资源为可展示 data URL。versionId 缺省时由
   * 后端解析当前版本；历史读取必须显式指定——Markdown 与图片必须来自
   * 同一版本。
   */
  resolveLocalAsset(
    skillId: string,
    markdownPath: string,
    assetPath: string,
    versionId?: string,
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
  getDraft: unavailable,
  listMarkdownFiles: unavailable,
  openDefaultApplication: unavailable,
  openExternalUrl: unavailable,
  openSkillFolder: unavailable,
  readMarkdownFile: unavailable,
  resolveLocalAsset: unavailable,
  saveDraft: unavailable,
  saveMarkdownAsCopy: unavailable,
  saveSkillContent: unavailable,
  validateMarkdown: unavailable,
};

const markdownKey = (skillId: string) => ["skill-markdown", skillId] as const;

export const markdownKeys = {
  /** 单个本地资源查询键：携版本身份，缺省记为 current（后端解析当前版本）。 */
  asset: (skillId: string, filePath: string, assetPath: string, versionId?: string) =>
    [...markdownKey(skillId), "asset", filePath, assetPath, versionId ?? "current"] as const,
  /** 技能下全部资源查询的前缀键：版本变化后按前缀失效，旧版本缓存不再沿用。 */
  assets: (skillId: string) => [...markdownKey(skillId), "asset"] as const,
  files: (skillId: string) => [...markdownKey(skillId), "files"] as const,
  file: (skillId: string, path: string) =>
    [...markdownKey(skillId), "file", path] as const,
  root: ["skill-markdown"] as const,
  skill: markdownKey,
};
