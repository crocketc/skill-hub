import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { MarkdownContentConflictError } from "./api";
import { MarkdownEditor } from "./MarkdownEditor";
import { SYNC_SCROLL_STORAGE_KEY } from "./syncScroll";
import {
  createMockMarkdownFacade,
  type MockMarkdownOptions,
} from "./testFixtures";

async function renderEditor(
  options: MockMarkdownOptions = {},
  props: { onExit?: () => void } = {},
) {
  const facade = createMockMarkdownFacade(options);
  const file = await facade.readMarkdownFile("pdf-reader", "SKILL.md");
  const i18n = await createSkillHubI18n(["en-US"]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <MarkdownEditor
            facade={facade}
            file={file}
            onSaved={() => undefined}
            onExit={props.onExit}
            skillId="pdf-reader"
          />
        </I18nextProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return facade;
}

async function replaceEditorText(text: string) {
  const user = userEvent.setup();
  const editor = screen.getByRole("textbox", { name: "Markdown source" });
  await user.click(editor);
  await user.keyboard("{Control>}a{/Control}");
  await user.paste(text);
}

function findSourceScroller() {
  return document.querySelector<HTMLElement>(
    ".sh-markdown-editor__pane--source .cm-scroller",
  );
}

function findPreviewPane() {
  return document.querySelector<HTMLElement>(".sh-markdown-editor__pane--preview");
}

function defineScrollable(
  element: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

describe("MarkdownEditor", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists a draft without creating a version until the guarded save is confirmed", async () => {
    const facade = await renderEditor();
    await replaceEditorText("A changed");

    expect(await screen.findByText("Draft saved locally")).toBeVisible();
    expect(facade.calls.savedVersions).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
    // 受控替换：确认对话框先出现，确认后才生成版本。
    fireEvent.click(await screen.findByRole("button", { name: "Replace and save" }));

    expect(await screen.findByText("Version v2 created")).toBeVisible();
    expect(facade.calls.savedVersions).toHaveLength(1);
    expect(facade.calls.savedVersions[0]?.markdown).toBe("A changed");
  });

  it("announces draft and version state through a polite live region", async () => {
    await renderEditor();
    await replaceEditorText("Announced");

    // 保存/校验状态必须在同一个礼貌播报区内动态更新。
    const draftMessage = await screen.findByText("Draft saved locally");
    const region = draftMessage.closest("[role='status'][aria-live='polite']");
    expect(region).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and save" }));

    await waitFor(() => {
      expect(region).toHaveTextContent("Version v2 created");
    });
  });

  it("keeps the source and draft when blocking validation prevents save", async () => {
    const facade = await renderEditor({
      validationIssues: [
        { code: "frontmatter", message: "Missing name", severity: "error" },
      ],
    });
    await replaceEditorText("Unsaved work");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));

    const alert = await screen.findByRole("alert", { name: "Save issues" });
    expect(alert).toHaveTextContent("Missing name");
    // 状态 = 图标 + 文字，不能只靠颜色区分严重性。
    expect(alert.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
      "Unsaved work",
    );
    expect(facade.calls.savedVersions).toEqual([]);
    // 校验错误在确认对话框之前阻断：面板根本不应出现。
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("pairs the save failure alert with a decorative icon", async () => {
    await renderEditor({ failSave: true });
    await replaceEditorText("Keep this draft");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not save; your local draft is still available.",
    );
    expect(alert.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
        "Keep this draft",
      );
    });
  });

  it("requires an explicit continuation before saving validation warnings", async () => {
    const facade = await renderEditor({
      validationIssues: [
        { code: "reference", message: "Image is missing", severity: "warning" },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
    expect(await screen.findByText("Image is missing")).toBeVisible();
    expect(facade.calls.savedVersions).toEqual([]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save despite warnings" }));
    expect(await screen.findByText("Version v2 created")).toBeVisible();
  });

  it("retains the editor value when the formal save fails", async () => {
    await renderEditor({ failSave: true });
    await replaceEditorText("Keep this draft");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save; your local draft is still available.",
    );
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
        "Keep this draft",
      );
    });
  });

  it("saves the edited draft as an independent copy and keeps the original editor open", async () => {
    const facade = await renderEditor();
    await replaceEditorText("Independent copy");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save as copy" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Copy saved as a new Skill");
    expect(facade.calls.copiedVersions).toHaveLength(1);
    expect(facade.calls.copiedVersions[0]?.markdown).toBe("Independent copy");
    expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
      "Independent copy",
    );
  });

  it("keeps the local draft and gives an actionable error when copy-save fails", async () => {
    await renderEditor({ failCopy: true });
    await replaceEditorText("Copy that must remain");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save as copy" }));

    expect(await screen.findByText(/Could not save the copy\. Check that the library is writable/))
      .toBeVisible();
    expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
      "Copy that must remain",
    );
  });

  it("discards the local draft and exits without creating a version", async () => {
    const onExit = vi.fn();
    const facade = await renderEditor({}, { onExit });
    await replaceEditorText("Unwanted changes");
    await screen.findByText("Draft saved locally");

    fireEvent.click(
      screen.getByRole("button", { name: "Discard changes and go back" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(onExit).toHaveBeenCalled());
    expect(facade.calls.discardedDrafts).toHaveLength(1);
    expect(facade.calls.savedVersions).toEqual([]);
  });

  it("explains that normal save creates a new version and exposes copy-save", async () => {
    await renderEditor();

    expect(screen.getByText(/Saving creates a new version/)).toBeVisible();
    const copyButton = screen.getByRole("button", { name: "Save as copy" });
    expect(copyButton).toBeEnabled();
  });

  it("guards the replace save behind a dialog that recommends a copy", async () => {
    await renderEditor();
    await replaceEditorText("Guarded replace");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Replace the original Skill content");
    // 覆盖风险 + 可恢复边界：原内容保留为历史版本，可在版本时间线回滚。
    expect(dialog).toHaveTextContent(/new version/);
    expect(dialog).toHaveTextContent(/history version/);
    expect(dialog).toHaveTextContent(/roll back/);
    // 推荐副本是主操作（视觉主按钮），替换保存是次操作。
    const recommended = within(dialog).getByRole("button", {
      name: "Save as copy (recommended)",
    });
    const replace = within(dialog).getByRole("button", { name: "Replace and save" });
    expect(recommended).toHaveClass("sh-button--primary");
    expect(replace).toHaveClass("sh-button--secondary");
  });

  it("replaces the original content exactly once from the guarded dialog", async () => {
    const facade = await renderEditor();
    await replaceEditorText("Replaced once");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and save" }));

    expect(await screen.findByText("Version v2 created")).toBeVisible();
    expect(facade.calls.savedVersions).toHaveLength(1);
    expect(facade.calls.savedVersions[0]?.markdown).toBe("Replaced once");
    expect(facade.calls.copiedVersions).toEqual([]);
  });

  it("cannot double-submit the replace save while it is in flight", async () => {
    let releaseSave: (() => void) | undefined;
    const facade = await renderEditor();
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const original = facade.saveSkillContent.bind(facade);
    facade.saveSkillContent = async (...args) => {
      await gate;
      return original(...args);
    };
    await replaceEditorText("Single flight");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and save" }));

    // 提交进行中：确认面板已关闭，保存入口禁用，无法重复提交。
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Save and create version" })).toBeDisabled();

    releaseSave?.();
    expect(await screen.findByText("Version v2 created")).toBeVisible();
    expect(facade.calls.savedVersions).toHaveLength(1);
  });

  it("saves a copy from the guarded dialog and never touches the original", async () => {
    const facade = await renderEditor();
    await replaceEditorText("Dialog copy");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save as copy (recommended)" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent("Copy saved as a new Skill");
    expect(facade.calls.copiedVersions).toHaveLength(1);
    expect(facade.calls.savedVersions).toEqual([]);
  });

  it("leaves content untouched when the replace confirmation is cancelled", async () => {
    const facade = await renderEditor();
    await replaceEditorText("Cancelled");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(facade.calls.savedVersions).toEqual([]);
    expect(facade.calls.copiedVersions).toEqual([]);
    expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
      "Cancelled",
    );
  });

  it("surfaces a content conflict raised from the guarded replace flow", async () => {
    const facade = await renderEditor();
    facade.saveSkillContent = () =>
      Promise.reject(new MarkdownContentConflictError("SKILL.md"));
    await replaceEditorText("Conflicting");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace and save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The file changed outside SkillHub. Your local draft was preserved.",
    );
    expect(facade.calls.copiedVersions).toEqual([]);
  });

  it("syncs the preview to the source editor while sync scrolling is on", async () => {
    await renderEditor();
    const source = findSourceScroller();
    const preview = findPreviewPane();
    expect(source).not.toBeNull();
    expect(preview).not.toBeNull();
    defineScrollable(source!, 2000, 500);
    defineScrollable(preview!, 1600, 400);

    source!.scrollTop = 300;
    fireEvent.scroll(source!);

    // 行比例同步：300/1500 = 0.2 → 预览可滚动 1200 × 0.2 = 240。
    expect(preview!.scrollTop).toBeCloseTo(240, 0);
  });

  it("maps a genuine preview scroll back without re-driving the source", async () => {
    await renderEditor();
    const source = findSourceScroller()!;
    const preview = findPreviewPane()!;
    defineScrollable(source, 2000, 500);
    defineScrollable(preview, 1600, 400);

    source.scrollTop = 300;
    fireEvent.scroll(source);
    expect(preview.scrollTop).toBeCloseTo(240, 0);

    // 浏览器会对程序化 scrollTop 赋值补发 scroll 事件；该回声不得反向驱动源面板。
    fireEvent.scroll(preview);
    expect(source.scrollTop).toBe(300);

    // 用户真实滚动预览（位置改变）才反向同步。
    preview.scrollTop = 1200;
    fireEvent.scroll(preview);
    expect(source.scrollTop).toBe(1500);
  });

  it("stops moving the preview once sync scrolling is switched off", async () => {
    const user = userEvent.setup();
    await renderEditor();
    const source = findSourceScroller()!;
    const preview = findPreviewPane()!;
    defineScrollable(source, 2000, 500);
    defineScrollable(preview, 1600, 400);

    const toggle = screen.getByRole("checkbox", { name: "Sync scrolling" });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    expect(toggle).not.toBeChecked();

    source.scrollTop = 600;
    fireEvent.scroll(source);
    expect(preview.scrollTop).toBe(0);
  });

  it("starts disabled when the stored preference says so", async () => {
    window.localStorage.setItem(SYNC_SCROLL_STORAGE_KEY, "false");
    await renderEditor();
    expect(screen.getByRole("checkbox", { name: "Sync scrolling" })).not.toBeChecked();
  });

  it("stores the toggle choice for the next session", async () => {
    const user = userEvent.setup();
    await renderEditor();
    await user.click(screen.getByRole("checkbox", { name: "Sync scrolling" }));
    expect(window.localStorage.getItem(SYNC_SCROLL_STORAGE_KEY)).toBe("false");
  });
});
