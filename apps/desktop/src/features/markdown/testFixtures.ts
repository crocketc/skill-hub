import {
  MarkdownContentConflictError,
  type MarkdownDraftBase,
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
  savedDrafts: Array<{
    base?: MarkdownDraftBase;
    markdown: string;
    path: string;
    skillId: string;
  }>;
  copiedVersions: Array<{
    expectedIdentity: string;
    markdown: string;
    path: string;
    skillId: string;
  }>;
  savedVersions: Array<{
    expectedIdentity: string;
    markdown: string;
    path: string;
    skillId: string;
  }>;
  /** K9：资源解析调用必须可观测——版本身份是否随调用传递就看这里。 */
  resolvedAssets: Array<{
    assetPath: string;
    markdownPath: string;
    skillId: string;
    versionId?: string | null;
  }>;
}

export interface MockMarkdownFacade extends MarkdownFacade {
  calls: MockMarkdownCalls;
  /** 测试可直接用 3 参形式预置草稿；编辑器调用时必须携带基准元数据。 */
  saveDraft(
    skillId: string,
    path: string,
    markdown: string,
    base?: MarkdownDraftBase,
  ): Promise<void>;
}

export interface MockMarkdownOptions {
  editable?: boolean;
  failSave?: boolean;
  failCopy?: boolean;
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
    versionId: "v1",
  },
  {
    contentIdentity: "sha256:usage-md-v1",
    editable: true,
    markdown: "# Usage notes\n\nUse the reader with local PDF files.",
    path: "docs/usage.md",
    versionId: "v1",
  },
];

/**
 * Deterministic rich document for the DEV-only workspace preview and its
 * layout acceptance: long code, a wide table, Mermaid, a large local image
 * and a remote image that must stay blocked until explicitly allowed.
 */
export const markdownPreviewDocument = [
  "# Preview surface fixture",
  "",
  "## Long code fence",
  "",
  "```typescript",
  `export function renderReport(rows: ReportRow[]): ReportSummary { const total = rows.reduce((sum, row) => sum + row.amount, 0); const average = rows.length > 0 ? total / rows.length : 0; return { total, average, largest: rows.reduce((best, row) => (row.amount > best.amount ? row : best), rows[0]); }`,
  "  const summary = renderReport(loadRows());",
  "  console.log(summary.total, summary.average);",
  "```",
  "",
  "## Wide table",
  "",
  "| Column A | Column B | Column C | Column D | Column E | Column F | Column G | Column H |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| alpha | bravo | charlie | delta | echo | foxtrot | golf | hotel |",
  "| 10001 | 10002 | 10003 | 10004 | 10005 | 10006 | 10007 | 10008 |",
  "| another rather long text cell that keeps pushing the table wider | bravo | charlie | delta | echo | foxtrot | golf | hotel |",
  "",
  "## Mermaid diagram",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Discover] --> B{Safe?}",
  "  B -->|yes| C[Import]",
  "  B -->|no| D[Block]",
  "  C --> E[Deploy]",
  "```",
  "",
  "## Large local image",
  "",
  "![Large diagram](images/diagram.png)",
  "",
  "## Remote image stays blocked",
  "",
  "![Remote scan](https://img.example/scan.png)",
  "",
].join("\n");

const largeDiagramAsset = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#3f7259"/><text x="80" y="140" font-family="sans-serif" font-size="56" fill="#eef0ec">1600 x 900 preview asset</text></svg>',
)}`;

/**
 * Preview facade: same deterministic contract as the unit mock, but the
 * primary document is the rich acceptance document, the local asset
 * resolves to an inline SVG data URL (no network), a restored draft and a
 * read-only file exercise the icon-plus-text status notices.
 */
export function createMarkdownPreviewFacade(): MockMarkdownFacade {
  const base = createMockMarkdownFacade();
  const readOnlyFile: MarkdownFileContent = {
    contentIdentity: "sha256:reference-md-v1",
    editable: false,
    markdown: "# Reference\n\nThis file is managed outside SkillHub.",
    path: "docs/reference.md",
    readOnlyReason: "external",
  };
  return {
    ...base,
    async listMarkdownFiles() {
      return [
        ...(await base.listMarkdownFiles("pdf-reader")),
        { label: readOnlyFile.path, path: readOnlyFile.path, primary: false },
      ];
    },
    async readMarkdownFile(skillId, path) {
      if (path === readOnlyFile.path) {
        return { ...readOnlyFile };
      }
      const file = await base.readMarkdownFile(skillId, path);
      if (path === "SKILL.md") {
        return {
          ...file,
          markdown: markdownPreviewDocument,
          draft: {
            baseContentIdentity: "sha256:skill-md-v1",
            baseVersionId: "v1",
            markdown: "# Recovered draft",
            savedAt: "2026-09-11T08:00:00Z",
          },
        };
      }
      return file;
    },
    async resolveLocalAsset(skillId, markdownPath, assetPath) {
      if (assetPath === "images/diagram.png") {
        return largeDiagramAsset;
      }
      return base.resolveLocalAsset(skillId, markdownPath, assetPath);
    },
  };
}

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
    copiedVersions: [],
    savedVersions: [],
    resolvedAssets: [],
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
    // K4：草稿查询与读取结果共用同一份草稿事实；无草稿时如实为 null。
    async getDraft(_skillId, path) {
      const file = requireFile(path);
      return file.draft ? { ...file.draft } : null;
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
    async readMarkdownFile(skillId, path) {
      const file = requireFile(path);
      if (path === "SKILL.md" && (skillId === "skill-doc" || skillId === "skill-sheet")) {
        const title = skillId === "skill-sheet" ? "Read spreadsheet data safely" : "Create Word documents safely";
        const name = skillId === "skill-sheet" ? "spreadsheet-reader" : "docx-writer";
        return {
          ...file,
          markdown: file.markdown
            .replace("name: pdf-reader", `name: ${name}`)
            .replace("# Extract PDF tables safely", `# ${title}`),
        };
      }
      return { ...file, draft: file.draft ? { ...file.draft } : undefined };
    },
    async resolveLocalAsset(skillId, markdownPath, assetPath, versionId) {
      calls.resolvedAssets.push({ assetPath, markdownPath, skillId, versionId });
      return `asset://skill/${encodeURIComponent(skillId)}/${encodeURIComponent(markdownPath)}/${encodeURIComponent(assetPath)}`;
    },
    async saveDraft(skillId, path, markdown, base?) {
      const file = requireFile(path);
      file.draft = {
        baseContentIdentity: base?.contentIdentity,
        baseVersionId: base?.versionId ?? null,
        markdown,
        savedAt: "2026-08-26T12:00:00Z",
      };
      calls.savedDrafts.push({ base, markdown, path, skillId });
    },
    async saveMarkdownAsCopy(skillId, path, markdown, expectedIdentity) {
      requireFile(path);
      if (options.failCopy) {
        throw new Error("Fixture copy save failed");
      }
      calls.copiedVersions.push({ expectedIdentity, markdown, path, skillId });
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
      file.versionId = "v2";
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
