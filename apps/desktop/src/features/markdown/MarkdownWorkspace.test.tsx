import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { MarkdownWorkspace } from "./MarkdownWorkspace";
import {
  createMockMarkdownFacade,
  type MockMarkdownFacade,
  type MockMarkdownOptions,
} from "./testFixtures";
import type { Location } from "react-router-dom";

let lastLocation: Location | null = null;

function LocationProbe() {
  lastLocation = useLocation();
  return null;
}

async function renderWorkspace(
  options: MockMarkdownOptions = {},
  setup?: (facade: MockMarkdownFacade) => Promise<void>,
  workspaceProps: { skillRootPath?: string | null } = {},
) {
  const facade = createMockMarkdownFacade(options);
  await setup?.(facade);
  const i18n = await createSkillHubI18n(["en-US"]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  lastLocation = null;
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={["/library/pdf-reader"]}>
            <Routes>
              <Route
                path="*"
                element={
                  <>
                    <MarkdownWorkspace
                      facade={facade}
                      skillId="pdf-reader"
                      {...workspaceProps}
                    />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return facade;
}

describe("MarkdownWorkspace", () => {
  it("opens SKILL.md first and switches other Markdown files independently", async () => {
    await renderWorkspace();

    expect(await screen.findByRole("heading", { name: "Markdown workspace" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Markdown file" })).toHaveValue(
      "SKILL.md",
    );
    expect(
      await screen.findByRole("heading", { name: "Extract PDF tables safely" }),
    ).toBeVisible();

    fireEvent.change(screen.getByRole("combobox", { name: "Markdown file" }), {
      target: { value: "docs/usage.md" },
    });

    expect(await screen.findByRole("heading", { name: "Usage notes" })).toBeVisible();
  });

  it("switches between read, source and edit without rewriting unknown source", async () => {
    await renderWorkspace();
    await screen.findByRole("heading", { name: "Extract PDF tables safely" });

    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByText("name: pdf-reader", { exact: false })).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    // 编辑器是懒加载 chunk，需要等待动态导入完成后再断言。
    expect(await screen.findByRole("textbox", { name: "Markdown source" })).toBeVisible();
  });

  it("persists the final editor input before switching files unmounts the editor", async () => {
    const facade = await renderWorkspace();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Extract PDF tables safely" });

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown source" });
    await user.click(editor);
    await user.keyboard("{Control>}a{/Control}");
    await user.paste("# Final input before switching");

    fireEvent.change(screen.getByRole("combobox", { name: "Markdown file" }), {
      target: { value: "docs/usage.md" },
    });
    expect(await screen.findByRole("heading", { name: "Usage notes" })).toBeVisible();

    await waitFor(() => {
      expect(facade.calls.savedDrafts).toContainEqual(expect.objectContaining({
        markdown: "# Final input before switching",
        path: "SKILL.md",
      }));
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Markdown file" }), {
      target: { value: "SKILL.md" },
    });
    await screen.findByRole("heading", { name: "Extract PDF tables safely" });
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    expect(await screen.findByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
      "# Final input before switching",
    );
  });

  // K4-B：切 Tab（编辑 → 阅读 → 编辑）前必须先把最新输入落成草稿，返回时
  // 内容恢复——防抖窗口内的最后击键不允许丢。
  it("restores the latest editor input when switching tabs away and back", async () => {
    const facade = await renderWorkspace();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Extract PDF tables safely" });

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown source" });
    await user.click(editor);
    await user.keyboard("{Control>}a{/Control}");
    await user.paste("# Tab switch keeps this");

    fireEvent.click(screen.getByRole("tab", { name: "Read" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Edit" }));
    expect(await screen.findByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
      "# Tab switch keeps this",
    );
    await waitFor(() => {
      expect(facade.calls.savedDrafts).toContainEqual(expect.objectContaining({
        markdown: "# Tab switch keeps this",
        path: "SKILL.md",
      }));
    });
  });

  it("never offers in-place edit for a read-only external Skill", async () => {
    await renderWorkspace(
      { editable: false, readOnlyReason: "external" },
      undefined,
      { skillRootPath: "C:/SkillHub/library/pdf-reader" },
    );

    expect(
      await screen.findByText("This file is read-only because it is managed externally."),
    ).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Edit" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Take over" }));

    // K9：接管跳既有身份/共享/权限预览流程（本地发现的导入预览流），
    // 来源路径用真实可见树根预填，不以 mock 状态宣称已接管。
    expect(lastLocation?.pathname).toBe("/discovery/local");
    expect(lastLocation?.state).toEqual({
      initialSources: ["C:/SkillHub/library/pdf-reader"],
    });
  });

  it("navigates to local discovery without a prefilled source when the tree root is unknown", async () => {
    await renderWorkspace(
      { editable: false, readOnlyReason: "external" },
      undefined,
      { skillRootPath: null },
    );
    await screen.findByRole("heading", { name: "Extract PDF tables safely" });

    fireEvent.click(screen.getByRole("button", { name: "Take over" }));

    // root_path 缺失（可见树未物化）时诚实降级：仍可去本地发现手动选来源，
    // 绝不编造一个路径。
    expect(lastLocation?.pathname).toBe("/discovery/local");
    expect(lastLocation?.state ?? null).toBeNull();
  });

  it("keeps the page processable with a readable alert when opening the default app fails", async () => {
    await renderWorkspace({}, async (fixture) => {
      fixture.openDefaultApplication = async () => {
        throw new Error("Fixture open denied");
      };
    }, { skillRootPath: "C:/SkillHub/library/pdf-reader" });
    await screen.findByRole("heading", { name: "Markdown workspace" });

    fireEvent.click(screen.getByRole("button", { name: "Open in default app" }));

    // 失败留在原页面：可读说明出现，工作区与重试入口保持可用。
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not open: Fixture open denied");
    expect(screen.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open in default app" })).toBeVisible();
  });

  it("pairs the restored draft status with a decorative icon", async () => {
    await renderWorkspace({}, async (fixture) => {
      await fixture.saveDraft("pdf-reader", "SKILL.md", "# Recovered draft");
    });
    const draftStatus = (
      await screen.findByText("A local draft was restored.")
    ).closest('[role="status"]');
    expect(draftStatus).not.toBeNull();
    expect(
      draftStatus?.querySelector("svg[aria-hidden='true']"),
    ).not.toBeNull();
  });

  it("announces the read-only notice as a status with a decorative icon", async () => {
    await renderWorkspace({ editable: false, readOnlyReason: "external" });

    const notice = (
      await screen.findByText("This file is read-only because it is managed externally.")
    ).closest('[role="status"]');
    expect(notice).not.toBeNull();
    expect(notice?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  });

  it("restores a local draft by default and can discard it explicitly", async () => {
    const facade = await renderWorkspace({}, async (fixture) => {
      await fixture.saveDraft("pdf-reader", "SKILL.md", "# Recovered draft");
    });

    expect(await screen.findByText("A local draft was restored.")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    expect(await screen.findByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
      "# Recovered draft",
    );

    // 编辑中的草稿状态由编辑器承接；横幅与丢弃入口在阅读模式提供。
    fireEvent.click(screen.getByRole("tab", { name: "Read" }));
    expect(await screen.findByText("A local draft was restored.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Discard local draft" }));
    await waitFor(() => {
      expect(screen.queryByText("A local draft was restored.")).not.toBeInTheDocument();
    });
    expect(facade.calls.discardedDrafts).toEqual([
      { path: "SKILL.md", skillId: "pdf-reader" },
    ]);
  });

  it("routes open actions through the facade with the absolute tree path", async () => {
    const facade = await renderWorkspace({}, undefined, {
      skillRootPath: "C:/SkillHub/library/pdf-reader",
    });
    await screen.findByRole("heading", { name: "Extract PDF tables safely" });

    fireEvent.click(screen.getByRole("button", { name: "Open in default app" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose another app" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Skill folder" }));

    // K9：打开命令要求树内绝对路径；由真实可见树根与树内相对路径拼出。
    expect(facade.calls.openedDefaults).toEqual([
      { path: "C:/SkillHub/library/pdf-reader/SKILL.md", skillId: "pdf-reader" },
    ]);
    expect(facade.calls.chosenApplications).toEqual([
      { path: "C:/SkillHub/library/pdf-reader/SKILL.md", skillId: "pdf-reader" },
    ]);
    expect(facade.calls.openedFolders).toEqual(["C:/SkillHub/library/pdf-reader"]);
  });

  it("keeps open actions honest when the visible tree root is unknown", async () => {
    const facade = await renderWorkspace({}, undefined, { skillRootPath: null });
    await screen.findByRole("heading", { name: "Extract PDF tables safely" });

    fireEvent.click(screen.getByRole("button", { name: "Open in default app" }));

    // root_path 缺失时无法给出树内绝对路径：按钮不伪装成功，给出可读
    // 说明，且不发出注定失败的打开调用。
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/local folder location of this Skill is unknown/i);
    expect(facade.calls.openedDefaults).toEqual([]);
  });

  it("maps the platform chooser refusal to a readable message without faking success", async () => {
    const facade = await renderWorkspace({ editable: false, readOnlyReason: "external" }, undefined, {
      skillRootPath: "C:/SkillHub/library/pdf-reader",
    });
    await setupFacadeFailure(facade);
    await screen.findByRole("heading", { name: "Extract PDF tables safely" });

    fireEvent.click(screen.getByRole("button", { name: "Choose another app" }));

    // macOS 的 choose_external_application 返回 local_open.unsupported（带平台
    // 参数）：错误映射为可读文案并留在原页，绝不伪装成已打开。
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/does not offer an application chooser/i);
    expect(alert).toHaveTextContent("macos");
    expect(screen.getByRole("button", { name: "Choose another app" })).toBeVisible();
  });
});

async function setupFacadeFailure(facade: MockMarkdownFacade) {
  facade.chooseExternalApplication = async () => {
    throw {
      code: "local_open.unsupported",
      severity: "warning",
      params: { platform: "macos" },
      actions: ["acknowledge"],
    };
  };
}
