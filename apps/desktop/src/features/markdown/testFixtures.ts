import {
  MarkdownContentConflictError,
  type MarkdownFacade,
  type MarkdownFileContent,
  type MarkdownSaveResult,
  type MarkdownValidationIssue,
  MarkdownNotFoundError,
} from "./api";

export interface MockMarkdownCalls {
  chosenApplications: Array<{ path: string; skillId: string }>;
  discardedDrafts: Array<{ path: string; skillId: string }>;
  openedDefaults: Array<{ path: string; skillId: string }>;
  openedFolders: string[];
  openedUrls: string[];
  savedDrafts: Array<{ markdown: string; path: string; skillId: string }>;
  savedVersions: Array<{
    expectedIdentity: string;
    markdown: string;
    path: string;
    skillId: string;
  }>;
  takeovers: string[];
}

export interface MockMarkdownFacade extends MarkdownFacade {
  calls: MockMarkdownCalls;
}

export interface MockMarkdownOptions {
  editable?: boolean;
  failSave?: boolean;
  missingFile?: boolean;
  readOnlyReason?: MarkdownFileContent["readOnlyReason"];
  validationIssues?: MarkdownValidationIssue[];
}

const fixtureFiles: MarkdownFileContent[] = [
  {
    contentIdentity: "sha256:skill-md-v1",
    editable: true,
    markdown: "---\nname: pdf-reader\n---\n\n# Extract PDF tables safely\n",
    path: "SKILL.md",
  },
  {
    contentIdentity: "sha256:usage-md-v1",
    editable: true,
    markdown: "# Usage notes\n\nUse the reader with local PDF files.",
    path: "docs/usage.md",
  },
];

export function createMockMarkdownFacade(
  options: MockMarkdownOptions = {},
): MockMarkdownFacade {
  const files = new Map(
    fixtureFiles.map((file) => [
      file.path,
      {
        ...file,
        editable: options.editable ?? file.editable,
        readOnlyReason: options.editable === false
          ? options.readOnlyReason ?? "external"
          : undefined,
      },
    ]),
  );
  const calls: MockMarkdownCalls = {
    chosenApplications: [],
    discardedDrafts: [],
    openedDefaults: [],
    openedFolders: [],
    openedUrls: [],
    savedDrafts: [],
    savedVersions: [],
    takeovers: [],
  };

  const requireFile = (path: string): MarkdownFileContent => {
    const file = files.get(path);
    if (options.missingFile || !file) {
      throw new MarkdownNotFoundError(path);
    }
    return file;
  };

  return {
    calls,
    async chooseExternalApplication(skillId, path) {
      calls.chosenApplications.push({ path, skillId });
    },
    async discardDraft(skillId, path) {
      const file = requireFile(path);
      delete file.draft;
      calls.discardedDrafts.push({ path, skillId });
    },
    async listMarkdownFiles() {
      return [...files.values()].map((file) => ({
        label: file.path,
        path: file.path,
        primary: file.path === "SKILL.md",
      }));
    },
    async openDefaultApplication(skillId, path) {
      calls.openedDefaults.push({ path, skillId });
    },
    async openExternalUrl(target) {
      calls.openedUrls.push(target);
    },
    async openSkillFolder(skillId) {
      calls.openedFolders.push(skillId);
    },
    async readMarkdownFile(_skillId, path) {
      const file = requireFile(path);
      return { ...file, draft: file.draft ? { ...file.draft } : undefined };
    },
    async requestTakeover(skillId) {
      calls.takeovers.push(skillId);
    },
    async resolveLocalAsset(skillId, markdownPath, assetPath) {
      return `asset://skill/${encodeURIComponent(skillId)}/${encodeURIComponent(markdownPath)}/${encodeURIComponent(assetPath)}`;
    },
    async saveDraft(skillId, path, markdown) {
      const file = requireFile(path);
      file.draft = { markdown, savedAt: "2026-08-26T12:00:00Z" };
      calls.savedDrafts.push({ markdown, path, skillId });
    },
    async saveSkillContent(skillId, path, markdown, expectedIdentity) {
      const file = requireFile(path);
      if (options.failSave) {
        throw new Error("Fixture save failed");
      }
      if (expectedIdentity !== file.contentIdentity) {
        throw new MarkdownContentConflictError(path);
      }
      calls.savedVersions.push({ expectedIdentity, markdown, path, skillId });
      file.markdown = markdown;
      file.contentIdentity = "sha256:skill-md-v2";
      delete file.draft;
      return {
        contentIdentity: file.contentIdentity,
        newVersionId: "v2",
      } satisfies MarkdownSaveResult;
    },
    async validateMarkdown() {
      return options.validationIssues ?? [];
    },
  };
}
