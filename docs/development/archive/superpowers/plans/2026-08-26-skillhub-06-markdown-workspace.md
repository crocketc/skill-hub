# SkillHub Task6 Markdown Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure Markdown reading, source-viewing, and lightweight editing workspace to Skill detail without allowing untrusted content to execute or drafts to overwrite formal Skill content implicitly.

**Architecture:** A dedicated `features/markdown` module owns a strong typed facade, pure URL/path policy, safe renderer, lazy Mermaid boundary, CodeMirror editor, and workspace orchestration. `SkillDetailPage` receives the Markdown facade separately from its detail facade so production-unavailable and deterministic preview data remain isolated.

**Tech Stack:** React 18, TypeScript, TanStack Query, react-markdown, remark-gfm, remark-frontmatter, prism-react-renderer, DOMPurify, Mermaid, CodeMirror 6 via `@uiw/react-codemirror`, Vitest, Testing Library, i18next.

**Spec:** `docs/superpowers/specs/2026-08-26-skillhub-task6-markdown-workspace-design.md`

## Global Constraints

- Windows and macOS behavior must remain behind typed application interfaces; UI code cannot access arbitrary filesystem paths.
- Production routes use an unavailable facade until generated Tauri bindings expose the real commands; only `/__preview` may use mutable fixtures.
- Remote images make no request before per-image confirmation, external links reveal their exact target before opening, and code is never executed.
- Editing writes a local draft first; only the explicit save action may create a version.
- Unknown Markdown source is preserved verbatim because previewing never rewrites editor content.
- All visible copy is added to both `zh-CN` and `en-US`; all component colors use existing theme tokens.
- Each production behavior follows red, green, refactor and ends with focused tests plus an independent commit.

---

### Task 1: Define Markdown contracts and security policy

**Files:**
- Create: `apps/desktop/src/features/markdown/api.ts`
- Create: `apps/desktop/src/features/markdown/api.test.ts`
- Create: `apps/desktop/src/features/markdown/sanitize.ts`
- Create: `apps/desktop/src/features/markdown/sanitize.test.ts`
- Create: `apps/desktop/src/features/markdown/testFixtures.ts`

**Interfaces:**
- Produces: `MarkdownFacade`, `MarkdownFileEntry`, `MarkdownFileContent`, `MarkdownValidationIssue`, `MarkdownSaveResult`, `classifyMarkdownUrl`, `normalizeSkillRelativePath`, `createMockMarkdownFacade`, and `unavailableMarkdownFacade`.

- [ ] **Step 1: Write failing policy and facade tests**

```ts
it.each([
  ["https://example.com/a", { kind: "external", target: "https://example.com/a" }],
  ["javascript:alert(1)", { kind: "blocked" }],
  ["../secret.png", { kind: "blocked" }],
  ["images/demo.png", { kind: "local", path: "images/demo.png" }],
])("classifies %s without allowing execution or root escape", (input, expected) => {
  expect(classifyMarkdownUrl(input)).toEqual(expected);
});

it("keeps production-unavailable distinct from a missing file", async () => {
  await expect(unavailableMarkdownFacade.listMarkdownFiles("pdf-reader"))
    .rejects.toBeInstanceOf(MarkdownUnavailableError);
});
```

- [ ] **Step 2: Run tests and verify the missing-module failure**

Run: `pnpm --dir apps/desktop test --run src/features/markdown/api.test.ts src/features/markdown/sanitize.test.ts`

Expected: FAIL because `api.ts` and `sanitize.ts` do not exist.

- [ ] **Step 3: Implement the minimal types and deterministic policy**

```ts
export interface MarkdownFileContent {
  contentIdentity: string;
  draft?: { markdown: string; savedAt: string };
  editable: boolean;
  markdown: string;
  path: string;
  readOnlyReason?: "builtin" | "external" | "plugin" | "permission";
}

export interface MarkdownFacade {
  listMarkdownFiles(skillId: string): Promise<MarkdownFileEntry[]>;
  readMarkdownFile(skillId: string, path: string): Promise<MarkdownFileContent>;
  resolveLocalAsset(skillId: string, markdownPath: string, assetPath: string): Promise<string>;
  saveDraft(skillId: string, path: string, markdown: string): Promise<void>;
  discardDraft(skillId: string, path: string): Promise<void>;
  validateMarkdown(skillId: string, path: string, markdown: string): Promise<MarkdownValidationIssue[]>;
  saveSkillContent(skillId: string, path: string, markdown: string, expectedIdentity: string): Promise<MarkdownSaveResult>;
  openDefaultApplication(skillId: string, path: string): Promise<void>;
  chooseExternalApplication(skillId: string, path: string): Promise<void>;
  openSkillFolder(skillId: string): Promise<void>;
  requestTakeover(skillId: string): Promise<void>;
  openExternalUrl(target: string): Promise<void>;
}
```

`classifyMarkdownUrl` accepts only `http:`, `https:`, same-document fragments, and normalized Skill-relative paths. Backslashes, absolute paths, drive prefixes, encoded traversal, protocol-relative URLs, and paths resolving above the Skill root return `{ kind: "blocked" }`.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --dir apps/desktop test --run src/features/markdown/api.test.ts src/features/markdown/sanitize.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```powershell
git add apps/desktop/src/features/markdown/api.ts apps/desktop/src/features/markdown/api.test.ts apps/desktop/src/features/markdown/sanitize.ts apps/desktop/src/features/markdown/sanitize.test.ts apps/desktop/src/features/markdown/testFixtures.ts
git commit -m "feat: define Markdown workspace contracts"
```

---

### Task 2: Render rich Markdown without executable HTML

**Files:**
- Create: `apps/desktop/src/features/markdown/MarkdownRenderer.tsx`
- Create: `apps/desktop/src/features/markdown/MarkdownRenderer.test.tsx`
- Create: `apps/desktop/src/features/markdown/ExternalLink.tsx`
- Create: `apps/desktop/src/features/markdown/RemoteImage.tsx`
- Create: `apps/desktop/src/features/markdown/CodeBlock.tsx`
- Create: `fixtures/skills/markdown-format/SKILL.md`
- Create: `fixtures/skills/markdown-unsafe/SKILL.md`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/desktop/src/i18n/en-US/common.json`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`

**Interfaces:**
- Consumes: `MarkdownFacade`, `classifyMarkdownUrl`.
- Produces: `<MarkdownRenderer facade skillId filePath markdown />`, `<ExternalLink target onOpen>`, `<RemoteImage source host onAllow>`, and `<CodeBlock language code>`.

- [ ] **Step 1: Install renderer dependencies**

Run: `pnpm --dir apps/desktop add react-markdown remark-gfm remark-frontmatter prism-react-renderer dompurify`

Expected: `package.json` and the frozen lockfile record the selected compatible versions.

- [ ] **Step 2: Add unsafe and rich fixtures, then write failing renderer tests**

```tsx
it("renders frontmatter, tasks, tables and highlighted code while dropping raw HTML", async () => {
  renderMarkdown(unsafeRichMarkdownFixture);
  expect(screen.getByRole("table")).toBeVisible();
  expect(screen.getByText("typescript")).toBeVisible();
  expect(screen.getByText("name: markdown-format")).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector("[onclick]")).toBeNull();
});

it("blocks a remote image and reveals an external target before opening", async () => {
  renderMarkdown("![x](https://img.example/x.png) [site](https://example.com)");
  expect(screen.getByText("Remote image blocked: img.example")).toBeVisible();
  fireEvent.click(screen.getByRole("link", { name: "site" }));
  expect(screen.getByText("https://example.com")).toBeVisible();
  expect(markdownFacade.calls.openedUrls).toEqual([]);
});
```

- [ ] **Step 3: Run renderer tests and verify the component-missing failure**

Run: `pnpm --dir apps/desktop test --run src/features/markdown/MarkdownRenderer.test.tsx`

Expected: FAIL because `MarkdownRenderer` does not exist.

- [ ] **Step 4: Implement the safe renderer and confirmation boundaries**

Use `ReactMarkdown` with `skipHtml`, `remarkGfm`, and `remarkFrontmatter`. Extract the opening Frontmatter block for a visible non-executable metadata panel, route links and images through `classifyMarkdownUrl`, render local images only from `resolveLocalAsset`, and use the existing `ConfirmDialog` for the exact external target. `CodeBlock` uses `prism-react-renderer`, provides language and copy controls, and never evaluates code.

- [ ] **Step 5: Run renderer and i18n tests**

Run: `pnpm --dir apps/desktop test --run src/features/markdown/MarkdownRenderer.test.tsx src/i18n/i18n.test.ts`

Expected: PASS, including identical English and Chinese key sets.

- [ ] **Step 6: Commit safe reading mode**

```powershell
git add apps/desktop/src/features/markdown apps/desktop/src/i18n fixtures/skills/markdown-format fixtures/skills/markdown-unsafe apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat: render Markdown through safe boundaries"
```

---

### Task 3: Add lazy strict Mermaid rendering and source fallback

**Files:**
- Create: `apps/desktop/src/features/markdown/MermaidBlock.tsx`
- Create: `apps/desktop/src/features/markdown/MermaidBlock.test.tsx`
- Modify: `apps/desktop/src/features/markdown/MarkdownRenderer.tsx`
- Modify: `apps/desktop/src/features/markdown/MarkdownRenderer.test.tsx`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `<MermaidBlock code onExternalTarget />`; the component exposes diagram/source tabs and falls back to `<CodeBlock language="mermaid">` on parse or render failure.

- [ ] **Step 1: Install Mermaid and write failing behavior tests**

Run: `pnpm --dir apps/desktop add mermaid`

```tsx
it("does not load Mermaid until a Mermaid fence requests a diagram", async () => {
  renderMarkdown("```ts\nconst safe = true\n```");
  expect(screen.queryByRole("tab", { name: "Diagram" })).not.toBeInTheDocument();
});

it("falls back to visible Mermaid source when strict rendering fails", async () => {
  render(<MermaidBlock code="graph TD; broken[" onExternalTarget={vi.fn()} />);
  expect(await screen.findByText("graph TD; broken[", { exact: false })).toBeVisible();
});
```

- [ ] **Step 2: Run tests and verify the missing-component failure**

Run: `pnpm --dir apps/desktop test --run src/features/markdown/MermaidBlock.test.tsx src/features/markdown/MarkdownRenderer.test.tsx`

Expected: FAIL because `MermaidBlock` is absent.

- [ ] **Step 3: Implement a dynamically imported strict Mermaid runtime**

Call `import("mermaid")` only inside the diagram branch, initialize with `securityLevel: "strict"`, `startOnLoad: false`, and `flowchart: { htmlLabels: false }`, sanitize returned SVG through DOMPurify, and intercept sanitized SVG anchors at the container boundary. Any import, parse, sanitize, or render failure selects the source fallback without discarding `code`.

- [ ] **Step 4: Run focused tests and build to inspect code splitting**

Run: `pnpm --dir apps/desktop test --run src/features/markdown/MermaidBlock.test.tsx src/features/markdown/MarkdownRenderer.test.tsx && pnpm --dir apps/desktop build`

Expected: PASS and a separate Mermaid runtime chunk appears in the Vite output.

- [ ] **Step 5: Commit Mermaid support**

```powershell
git add apps/desktop/src/features/markdown apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat: preview Mermaid with strict fallback"
```

---

### Task 4: Implement local drafts and explicit version saves

**Files:**
- Create: `apps/desktop/src/features/markdown/MarkdownEditor.tsx`
- Create: `apps/desktop/src/features/markdown/MarkdownEditor.test.tsx`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/desktop/src/i18n/en-US/common.json`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`

**Interfaces:**
- Consumes: `MarkdownFacade`, `MarkdownFileContent`, `MarkdownRenderer`.
- Produces: `<MarkdownEditor facade skillId file onSaved />` with source/split preview, draft state, validation summary, and explicit save.

- [ ] **Step 1: Install CodeMirror and interaction-test dependencies**

Run: `pnpm --dir apps/desktop add @uiw/react-codemirror @codemirror/lang-markdown @codemirror/search && pnpm --dir apps/desktop add -D @testing-library/user-event`

- [ ] **Step 2: Write failing draft, validation and save tests**

```tsx
it("persists a draft without creating a version until explicit save", async () => {
  const user = userEvent.setup();
  renderEditor({ markdown: "# A" });
  await user.click(screen.getByRole("textbox", { name: "Markdown source" }));
  await user.keyboard(" changed");
  await waitFor(() => expect(screen.getByText("Draft saved locally")).toBeVisible());
  expect(screen.queryByText("Version v2 created")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save and create version" }));
  expect(await screen.findByText("Version v2 created")).toBeVisible();
});

it("keeps source and draft when blocking validation prevents save", async () => {
  renderEditor({ issues: [{ code: "frontmatter", message: "Missing name", severity: "error" }] });
  fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
  expect(await screen.findByRole("alert", { name: "Save issues" })).toHaveTextContent("Missing name");
  expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveTextContent("# A");
});
```

- [ ] **Step 3: Run editor tests and verify the missing-component failure**

Run: `pnpm --dir apps/desktop test --run src/features/markdown/MarkdownEditor.test.tsx`

Expected: FAIL because `MarkdownEditor` does not exist.

- [ ] **Step 4: Implement CodeMirror state and save flow**

Initialize editor state lazily from `file.draft?.markdown ?? file.markdown`. Use CodeMirror Markdown and search extensions, a 500 ms draft debounce, and primitive effect dependencies. The explicit save handler calls `validateMarkdown`, focuses the issue summary on blocking errors, otherwise calls `saveSkillContent` with `file.contentIdentity`, clears the draft, and invokes `onSaved(newVersionId)`. Failures retain the editor value and expose an inline alert.

- [ ] **Step 5: Run editor and i18n tests**

Run: `pnpm --dir apps/desktop test --run src/features/markdown/MarkdownEditor.test.tsx src/i18n/i18n.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit lightweight editing**

```powershell
git add apps/desktop/src/features/markdown/MarkdownEditor.tsx apps/desktop/src/features/markdown/MarkdownEditor.test.tsx apps/desktop/src/i18n apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat: edit Markdown through local drafts"
```

---

### Task 5: Compose file, mode and read-only workspace states

**Files:**
- Create: `apps/desktop/src/features/markdown/MarkdownWorkspace.tsx`
- Create: `apps/desktop/src/features/markdown/MarkdownWorkspace.test.tsx`
- Modify: `apps/desktop/src/features/markdown/api.ts`
- Modify: `apps/desktop/src/features/markdown/testFixtures.ts`
- Modify: `apps/desktop/src/i18n/en-US/common.json`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`

**Interfaces:**
- Consumes: all Task1-4 module contracts.
- Produces: `<MarkdownWorkspace facade skillId />` with file selection, read/source/edit tabs, draft recovery, retry, read-only takeover, and external-open actions.

- [ ] **Step 1: Write failing workspace behavior tests**

```tsx
it("opens SKILL.md first and switches other Markdown files independently", async () => {
  renderWorkspace();
  expect(await screen.findByRole("heading", { name: "Markdown workspace" })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Markdown file" })).toHaveValue("SKILL.md");
  fireEvent.change(screen.getByRole("combobox", { name: "Markdown file" }), { target: { value: "docs/usage.md" } });
  expect(await screen.findByText("Usage notes")).toBeVisible();
});

it("never offers in-place edit for a read-only external Skill", async () => {
  renderWorkspace({ editable: false, readOnlyReason: "external" });
  expect(await screen.findByText("This file is read-only because it is managed externally.")).toBeVisible();
  expect(screen.queryByRole("tab", { name: "Edit" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy into SkillHub" })).toBeVisible();
});
```

- [ ] **Step 2: Run workspace tests and verify the missing-component failure**

Run: `pnpm --dir apps/desktop test --run src/features/markdown/MarkdownWorkspace.test.tsx`

Expected: FAIL because `MarkdownWorkspace` does not exist.

- [ ] **Step 3: Implement query orchestration and accessible tabs**

List files and read the selected file through distinct query keys. Keep `SKILL.md` first, use explicit loading/error/unavailable/empty states, expose read and source tabs for every file, and add edit only when `file.editable` is true. Draft recovery uses the draft content by default with a visible discard action. External actions call only facade methods.

- [ ] **Step 4: Run all Markdown tests**

Run: `pnpm --dir apps/desktop test --run src/features/markdown`

Expected: PASS.

- [ ] **Step 5: Commit the workspace**

```powershell
git add apps/desktop/src/features/markdown apps/desktop/src/i18n
git commit -m "feat: compose Markdown workspace modes"
```

---

### Task 6: Integrate Markdown into Skill detail and isolated preview

**Files:**
- Modify: `apps/desktop/src/features/skill-detail/SkillDetailPage.tsx`
- Modify: `apps/desktop/src/features/skill-detail/SkillDetailPage.test.tsx`
- Modify: `apps/desktop/src/features/skill-detail/SkillDetailPreview.tsx`
- Modify: `apps/desktop/src/app/router.test.tsx`
- Modify: `apps/desktop/src/styles/base.css`
- Create: `apps/desktop/src/features/markdown/markdown.css`
- Modify: `apps/desktop/src/app/router.tsx`

**Interfaces:**
- Consumes: `<MarkdownWorkspace facade skillId />`, `createMockMarkdownFacade`, and `unavailableMarkdownFacade`.
- Produces: Markdown workspace inside the detail description flow; preview uses deterministic Markdown while production retains the explicit unavailable boundary.

- [ ] **Step 1: Write failing detail integration and route-isolation tests**

```tsx
it("places the Markdown workspace after description metadata", async () => {
  await renderDetail({ markdownFacade: createMockMarkdownFacade() });
  expect(await screen.findByRole("heading", { name: "Markdown workspace" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Read" })).toBeVisible();
});

it("keeps interactive Markdown fixtures out of the production route", async () => {
  renderRouter("/__preview/skill-detail/skill-pdf");
  expect(await screen.findByText("Extract PDF tables safely")).toBeVisible();
  navigateTo("/library/skill-pdf");
  expect(await screen.findByText("Skill detail data is not connected yet")).toBeVisible();
  expect(screen.queryByText("Extract PDF tables safely")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run focused tests and verify the absent-workspace failure**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/SkillDetailPage.test.tsx src/app/router.test.tsx -t "Markdown|Skill detail"`

Expected: FAIL because Skill detail does not render `MarkdownWorkspace`.

- [ ] **Step 3: Implement facade injection, preview composition and product styling**

Add optional `markdownFacade = unavailableMarkdownFacade` to `SkillDetailPage`, render the workspace after `MetadataPanel`, and seed `SkillDetailPreview` with one lazily initialized Markdown facade. Import `markdown.css` next to `base.css`. Use a compact toolbar, hairline token borders, fixed editor controls, `content-visibility` for long reading content, horizontal code scrolling, 44 px minimum interactive targets where pointer input requires them, and a single-column narrow layout.

- [ ] **Step 4: Run focused integration, i18n and type checks**

Run: `pnpm --dir apps/desktop test --run src/features/skill-detail/SkillDetailPage.test.tsx src/app/router.test.tsx src/i18n/i18n.test.ts && pnpm --dir apps/desktop check`

Expected: PASS.

- [ ] **Step 5: Commit detail integration**

```powershell
git add apps/desktop/src/features/skill-detail apps/desktop/src/features/markdown/markdown.css apps/desktop/src/app/router.tsx apps/desktop/src/app/router.test.tsx apps/desktop/src/styles/base.css
git commit -m "feat: embed Markdown workspace in Skill detail"
```

---

### Task 7: Verify Task6 security, quality and build output

**Files:**
- Modify only files implicated by verification failures within Task6 scope.

**Interfaces:**
- Produces: a tested Task6 branch ready for review; no publishing or merge action.

- [ ] **Step 1: Run the complete frontend test suite**

Run: `pnpm test:frontend`

Expected: every Vitest file passes with zero failed tests.

- [ ] **Step 2: Run lint and TypeScript validation**

Run: `pnpm check:frontend`

Expected: ESLint exits with zero warnings and `tsc --noEmit` exits successfully.

- [ ] **Step 3: Run the production build**

Run: `pnpm build:frontend`

Expected: Vite builds successfully; Mermaid remains in a lazy chunk rather than the initial application chunk.

- [ ] **Step 4: Run whitespace and repository-scope checks**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional Task6 files are listed.

- [ ] **Step 5: Run the finesse product UI pre-flight**

Inspect the Task6 preview at desktop and narrow widths. Verify theme-token surfaces, dense but legible hierarchy, keyboard reachability, visible focus, non-color status labels, long Markdown/code overflow, reduced-motion behavior, remote-image blocking, exact external targets, and no unapproved component-shape changes.

- [ ] **Step 6: Commit verification-only corrections if any exist**

```powershell
git add apps/desktop/src/features/markdown apps/desktop/src/features/skill-detail apps/desktop/src/app apps/desktop/src/i18n apps/desktop/src/styles apps/desktop/package.json pnpm-lock.yaml fixtures/skills/markdown-format fixtures/skills/markdown-unsafe
git commit -m "fix: harden Markdown workspace verification"
```

Skip this commit when verification produced no corrective changes.
