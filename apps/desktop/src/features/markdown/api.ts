export interface MarkdownFileEntry {
  label: string;
  path: string;
  primary: boolean;
}

export interface MarkdownDraft {
  markdown: string;
  savedAt: string;
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
  saveDraft(skillId: string, path: string, markdown: string): Promise<void>;
  saveSkillContent(
    skillId: string,
    path: string,
    markdown: string,
    expectedIdentity: string,
  ): Promise<MarkdownSaveResult>;
  validateMarkdown(
    skillId: string,
    path: string,
    markdown: string,
  ): Promise<MarkdownValidationIssue[]>;
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
