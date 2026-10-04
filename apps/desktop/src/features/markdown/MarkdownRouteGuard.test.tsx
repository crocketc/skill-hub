import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { createMemoryRouter, Link, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { MarkdownRouteGuard } from "./MarkdownRouteGuard";
import { MarkdownWorkspace } from "./MarkdownWorkspace";
import { createMockMarkdownFacade, type MockMarkdownFacade } from "./testFixtures";

/**
 * K4-B 离开保护必须在数据路由层拦截（useBlocker 依赖 createBrowserRouter/
 * createMemoryRouter 数据路由上下文），所以本文件用数据路由渲染守卫 + 工作区。
 */
async function renderGuardedWorkspace(): Promise<MockMarkdownFacade> {
  const facade = createMockMarkdownFacade();
  const i18n = await createSkillHubI18n(["en-US"]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <>
            <MarkdownRouteGuard />
            <MarkdownWorkspace facade={facade} skillId="pdf-reader" />
            <Link to="/other">Go elsewhere</Link>
          </>
        ),
      },
      {
        path: "/other",
        element: <p>Other page</p>,
      },
    ],
    { initialEntries: ["/"] },
  );
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return facade;
}

async function typeDraft(text: string) {
  const user = userEvent.setup();
  fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
  const editor = await screen.findByRole("textbox", { name: "Markdown source" });
  await user.click(editor);
  await user.keyboard("{Control>}a{/Control}");
  await user.paste(text);
  return user;
}

describe("MarkdownRouteGuard", () => {
  it("intercepts in-app navigation while an unsaved draft exists and offers stay or abandon", async () => {
    const facade = await renderGuardedWorkspace();
    expect(await screen.findByRole("heading", { name: "Extract PDF tables safely" })).toBeVisible();

    await typeDraft("# Guarded draft");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("link", { name: "Go elsewhere" }));

    // 离开被拦截：用户必须显式选择留下或放弃，不允许静默丢失。
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Unsaved draft on this page");
    expect(screen.queryByText("Other page")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Stay and keep editing" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    // 留下：仍在本页（编辑器与未保存内容原样保留），未发生路由跳转。
    expect(screen.queryByText("Other page")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
      "# Guarded draft",
    );

    fireEvent.click(screen.getByRole("link", { name: "Go elsewhere" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard draft and leave",
      }),
    );

    expect(await screen.findByText("Other page")).toBeVisible();
    expect(facade.calls.discardedDrafts).toEqual([
      { path: "SKILL.md", skillId: "pdf-reader" },
    ]);
  });

  it("warns on window close while the guard is armed and stays silent when clean", async () => {
    await renderGuardedWorkspace();
    expect(await screen.findByRole("heading", { name: "Extract PDF tables safely" })).toBeVisible();

    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);

    await typeDraft("# Close-guarded");

    const armedUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(armedUnload);
    expect(armedUnload.defaultPrevented).toBe(true);
  });
});
