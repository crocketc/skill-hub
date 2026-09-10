import { useState } from "react";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { MarkdownWorkspace } from "./MarkdownWorkspace";
import { createMarkdownPreviewFacade } from "./testFixtures";

/**
 * DEV-only deterministic Markdown workspace board (/__preview/markdown-workspace).
 * Mirrors the Skill detail outline (top-bar h1 -> page h2 -> workspace h3)
 * so heading levels, states, images and theme behavior can be accepted on a
 * fixed fixture. Not wired into production routing; no real skill data.
 */
export function MarkdownWorkspacePreview() {
  const [facade] = useState(() => createMarkdownPreviewFacade());
  return (
    <PageFrame width="wide">
      {/* 顶栏（AppShell）负责路由级 h1；页面内容从 h2 开始。 */}
      <PageHeader
        description="Deterministic fixture for the Markdown workspace acceptance matrix."
        title="Markdown workspace preview"
      />
      <section aria-labelledby="markdown-preview-section">
        <h2 id="markdown-preview-section">Skill description</h2>
        <MarkdownWorkspace facade={facade} skillId="pdf-reader" />
      </section>
    </PageFrame>
  );
}
