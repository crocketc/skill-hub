import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { createMockMarkdownFacade } from "./testFixtures";

const richUnsafeMarkdown = `---
name: markdown-format
description: Safe fixture
---

# Markdown format fixture

- [x] Task list item

| Format | Supported |
| --- | --- |
| Table | Yes |

~~Removed text~~

\`\`\`typescript
const enabled = true;
\`\`\`

<script>window.skillHubCompromised = true</script>
<img src="x" onclick="window.skillHubCompromised = true">
`;

async function renderMarkdown(markdown: string) {
  const facade = createMockMarkdownFacade();
  const i18n = await createSkillHubI18n(["en-US"]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <MarkdownRenderer
            facade={facade}
            filePath="SKILL.md"
            markdown={markdown}
            skillId="pdf-reader"
          />
        </I18nextProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return facade;
}

describe("MarkdownRenderer", () => {
  it("maps markdown headings below the workspace outline so detail pages keep a single h1", async () => {
    await renderMarkdown(
      "# Document title\n\n## Section\n\n### Subsection\n\n#### Deep",
    );

    // 详情页 outline：路由 h1 -> 章节 h2 -> 工作区 h3，Markdown 标题必须落在其下。
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Document title", level: 4 }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Section", level: 5 })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Subsection", level: 6 }),
    ).toBeVisible();
    // 更深的 Markdown 标题收敛到 h6，保持相对层级的视觉映射。
    expect(screen.getByRole("heading", { name: "Deep", level: 6 })).toBeVisible();
  });

  it("renders GFM, frontmatter and code while dropping raw executable HTML", async () => {
    await renderMarkdown(richUnsafeMarkdown);

    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Task list item" })).toBeChecked();
    expect(screen.getByText("name: markdown-format", { exact: false })).toBeVisible();
    expect(screen.getByText("typescript")).toBeVisible();
    expect(screen.getByText("Removed text").tagName).toBe("DEL");
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("[onclick]")).toBeNull();
  });

  it("blocks remote images until the user explicitly allows one", async () => {
    await renderMarkdown("![Tracker](https://img.example/tracker.png)");

    expect(screen.getByText("Remote image blocked: img.example")).toBeVisible();
    expect(screen.queryByRole("img", { name: "Tracker" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load this image" }));

    expect(screen.getByRole("img", { name: "Tracker" })).toHaveAttribute(
      "src",
      "https://img.example/tracker.png",
    );
  });

  it("keeps a stable busy placeholder around an allowed image until it loads", async () => {
    await renderMarkdown("![Tracker](https://img.example/tracker.png)");

    fireEvent.click(screen.getByRole("button", { name: "Load this image" }));

    // 加载完成前占位区域保持 busy，避免图片到达时正文跳动。
    const image = screen.getByRole("img", { name: "Tracker" });
    expect(image.closest("[aria-busy='true']")).not.toBeNull();

    fireEvent.load(image);

    expect(image.closest("[aria-busy='true']")).toBeNull();
  });

  it("reveals the exact external target before opening it", async () => {
    const facade = await renderMarkdown("[site](https://example.com/path?q=1)");

    fireEvent.click(screen.getByRole("link", { name: "site" }));
    expect(
      screen.getByRole("alertdialog", { name: "Open external link?" }),
    ).toHaveTextContent("https://example.com/path?q=1");
    expect(facade.calls.openedUrls).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Open link" }));
    expect(facade.calls.openedUrls).toEqual(["https://example.com/path?q=1"]);
  });

  it("resolves local images through the controlled facade behind a stable placeholder", async () => {
    await renderMarkdown("![Diagram](images/diagram.png)");

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "Diagram" })).toHaveAttribute(
        "src",
        "asset://skill/pdf-reader/SKILL.md/images%2Fdiagram.png",
      );
    });

    // 受控解析完成后，图片同样在稳定占位内等待加载完成。
    const image = screen.getByRole("img", { name: "Diagram" });
    expect(image.closest("[aria-busy='true']")).not.toBeNull();

    fireEvent.load(image);

    expect(image.closest("[aria-busy='true']")).toBeNull();
  });

  it("shows blocked references as text without a navigable target", async () => {
    await renderMarkdown("[unsafe](javascript:alert(1)) ![escape](../outside.png)");

    expect(screen.getByText("unsafe")).not.toHaveAttribute("href");
    expect(screen.getByText("Blocked resource: ../outside.png")).toBeVisible();
  });

  it("offers diagram and source views only for Mermaid code fences", async () => {
    await renderMarkdown("```mermaid\ngraph TD; A-->B\n```");

    expect(screen.getByRole("tab", { name: "Diagram" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByText("graph TD; A-->B", { exact: false })).toBeVisible();
  });
});
