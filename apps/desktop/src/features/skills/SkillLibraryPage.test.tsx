import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryRouter,
  RouterProvider,
  type InitialEntry,
} from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { skillHubI18n } from "../../i18n";
import "../../styles/base.css";
import {
  SkillLibraryUnavailableError,
  type SavedSkillView,
  type SkillDrawerPreferences,
  type SkillLibraryFacade,
  type SkillPage,
} from "./api";
import { SkillLibraryPage } from "./SkillLibraryPage";
import {
  createMockSkillLibraryFacade,
  MOCK_SKILL_PDF,
  type MockSkillLibraryFacade,
} from "./testFixtures";

interface RenderLibraryOptions {
  facade: SkillLibraryFacade;
  initialEntry?: InitialEntry;
  queryRetry?: boolean | number;
}

interface RenderedLibrary {
  queryClient: QueryClient;
  router: ReturnType<typeof createMemoryRouter>;
}

function renderLibrary({
  facade,
  initialEntry = "/library",
  queryRetry = false,
}: RenderLibraryOptions): RenderedLibrary {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: queryRetry, retryDelay: 0 } },
  });
  const router = createMemoryRouter(
    [{ path: "/library", element: <SkillLibraryPage facade={facade} /> }],
    { initialEntries: [initialEntry] },
  );

  render(
    <I18nextProvider i18n={skillHubI18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  );

  return { queryClient, router };
}

function lastPageCall(facade: MockSkillLibraryFacade) {
  return facade.calls.listSkills.at(-1);
}

function skillNameCell(name: string): HTMLTableCellElement {
  const cell = screen.getByText(name).closest("td");
  if (!(cell instanceof HTMLTableCellElement)) {
    throw new Error(`Expected a table cell for ${name}`);
  }
  return cell;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SkillLibraryPage", () => {
  it("collapses and expands the filters with a compact toggle", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    const collapse = await screen.findByRole("button", { name: "Collapse filters" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);

    expect(screen.queryByRole("searchbox", { name: "Search skills" })).not.toBeInTheDocument();
    const expand = screen.getByRole("button", { name: "Expand filters" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expand);

    expect(await screen.findByRole("searchbox", { name: "Search skills" })).toBeVisible();
  });

  it("places the page result status in the results toolbar", async () => {
    const facade = createMockSkillLibraryFacade({ total: 80 });
    renderLibrary({ facade });

    const status = await screen.findByText("Page 1 · 80 results");
    expect(status.closest(".sh-skill-table__toolbar")).toBeInTheDocument();
  });

  it("distinguishes current-page selection from all filtered results", async () => {
    const facade = createMockSkillLibraryFacade({ total: 80 });
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select current page" }),
    );
    expect(screen.getByText("25 items selected on this page")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Select all 80 filtered results" }),
    );
    expect(screen.getByText("All 80 filtered results selected")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run security check" }));
    await waitFor(() => {
      expect(facade.calls.emitBatchIntent).toContainEqual({
        action: "security_check",
        target: {
          kind: "filtered",
          excludedSkillIds: [],
          filter: expect.objectContaining({ text: "" }),
        },
      });
    });
    expect(screen.queryByText("Security check completed")).not.toBeInTheDocument();
  });

  it("previews and confirms batch tag additions for the selected skills", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add tags" }));

    const dialog = await screen.findByRole("dialog", { name: "Add tags" });
    expect(within(dialog).getByText("This will affect 1 Skill")).toBeVisible();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Tags" }), {
      target: { value: "review, urgent" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tags" }));

    await waitFor(() => {
      expect(facade.calls.emitBatchIntent).toContainEqual({
        action: "add_tag",
        tags: ["review", "urgent"],
        target: { kind: "skill_ids", skillIds: ["skill-pdf"] },
      });
    });
  });

  it("places tag actions directly after add-to in the batch action bar", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );

    const batchBar = screen.getByRole("complementary", { name: "Batch actions" });
    const actions = batchBar.querySelector(".sh-skill-library__batch-actions");
    expect(actions).toBeInTheDocument();
    expect(
      within(actions as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual([
      "Add to",
      "Add tags",
      "Remove tags",
      "Run security check",
      "Export",
      "Archive",
      "Clear selection",
    ]);
  });

  it("restores query and drawer state from the URL and preserves scroll and focus", async () => {
    const facade = createMockSkillLibraryFacade();
    const view = renderLibrary({
      facade,
      initialEntry:
        "/library?q=pdf&page=2&size=25&future=preserve&skill=skill-pdf",
    });

    expect(await screen.findByDisplayValue("pdf")).toHaveAttribute(
      "type",
      "search",
    );
    expect(
      await screen.findByRole("dialog", { name: "PDF Reader" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(view.router.state.location.search).toBe(
      "?q=pdf&page=2&size=25&future=preserve",
    );
    const region = screen.getByRole("region", { name: "Skill results" });
    await waitFor(() => expect(region).toHaveFocus());

    region.scrollTop = 128;
    region.scrollLeft = 96;
    fireEvent.click(skillNameCell("PDF Reader"));
    expect(await screen.findByRole("dialog", { name: "PDF Reader" })).toBeVisible();
    region.scrollTop = 0;
    region.scrollLeft = 0;
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.getByRole("row", { name: /PDF Reader/ })).toHaveFocus();
    });
    expect(region.scrollTop).toBe(128);
    expect(region.scrollLeft).toBe(96);
  });

  it("restores the table position supplied by a returning detail page", async () => {
    const facade = createMockSkillLibraryFacade();
    const view = renderLibrary({
      facade,
      initialEntry: {
        pathname: "/library",
        search: "?q=pdf",
        state: {
          libraryReturn: {
            focusSkillId: "skill-pdf",
            scrollLeft: 32,
            scrollTop: 320,
          },
        },
      },
    });

    expect(view.router.state.location.state).toEqual({
      libraryReturn: {
        focusSkillId: "skill-pdf",
        scrollLeft: 32,
        scrollTop: 320,
      },
    });

    await screen.findByRole("row", { name: /PDF Reader/ });
    const region = screen.getByRole("region", { name: "Skill results" });
    await waitFor(() => {
      expect(region.scrollLeft).toBe(32);
      expect(region.scrollTop).toBe(320);
      expect(screen.getByRole("row", { name: /PDF Reader/ })).toHaveFocus();
    });
  });

  it("clears all-filtered selection when filters change", async () => {
    const facade = createMockSkillLibraryFacade({
      matchingSkillIds: ["skill-pdf"],
      total: 80,
    });
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select current page" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Select all 80/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
      target: { value: "reader" },
    });

    expect(
      await screen.findByText("Selection cleared because filters changed"),
    ).toHaveAttribute("role", "status");
    expect(screen.queryByText(/filtered results selected/)).not.toBeInTheDocument();
  });

  it("keeps a compact skeleton in place during the first page read", async () => {
    const facade = createMockSkillLibraryFacade();
    vi.spyOn(facade, "listSkills").mockReturnValue(new Promise<SkillPage>(() => undefined));

    renderLibrary({ facade });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Loading skill library",
    );
    expect(screen.getAllByTestId("skill-loading-row")).toHaveLength(6);
  });

  it("replaces stale rows with a non-interactive skeleton during filter reads", async () => {
    const facade = createMockSkillLibraryFacade();
    const initialList = facade.listSkills.bind(facade);
    const filteredPage = deferred<SkillPage>();
    vi.spyOn(facade, "listSkills").mockImplementation((query) =>
      query.text === "reader" ? filteredPage.promise : initialList(query),
    );
    renderLibrary({ facade });

    expect(await screen.findByRole("table")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
      target: { value: "reader" },
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Loading skill library",
    );
    expect(screen.getByRole("searchbox", { name: "Search skills" })).toHaveValue(
      "reader",
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /PDF Reader/ })).not.toBeInTheDocument();

    filteredPage.resolve({
      facets: { tags: ["documents", "pdf"] },
      items: [MOCK_SKILL_PDF],
      page: 1,
      pageSize: 25,
      total: 1,
    });
    expect(await screen.findByRole("row", { name: /PDF Reader/ })).toBeVisible();
  });

  it("distinguishes an empty library from an empty filtered result", async () => {
    const emptyLibrary = createMockSkillLibraryFacade({ pageItems: [], total: 0 });
    const first = renderLibrary({ facade: emptyLibrary });

    expect(await screen.findByText("No skills are in the library yet")).toBeVisible();
    expect(screen.getByText("Import is not connected yet")).toBeVisible();

    first.queryClient.clear();
    await act(() => first.router.navigate("/library?q=missing"));
    expect(
      await screen.findByText("No skills match the current filters"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeVisible();
  });

  it("shows ordinary page errors with retry without replacing unavailable semantics", async () => {
    const facade = createMockSkillLibraryFacade({
      failPage: new Error("disk read failed"),
    });
    renderLibrary({ facade });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load the skill library",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(facade.calls.listSkills.length).toBeGreaterThan(1));
  });

  it("shows a catalog-contract outage as unavailable rather than an application error", async () => {
    const facade = createMockSkillLibraryFacade({
      failPage: new SkillLibraryUnavailableError(),
    });
    renderLibrary({ facade });

    expect(
      await screen.findByText("Skill catalog data is not connected yet"),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("preserves the QueryClient retry policy for ordinary page failures", async () => {
    const facade = createMockSkillLibraryFacade();
    const successfulList = facade.listSkills.bind(facade);
    const listSkills = vi
      .spyOn(facade, "listSkills")
      .mockRejectedValueOnce(new Error("transient page read failure"))
      .mockImplementation((query) => successfulList(query));

    renderLibrary({ facade, queryRetry: 1 });

    expect(await screen.findByRole("table")).toBeVisible();
    expect(listSkills).toHaveBeenCalledTimes(2);
  });

  it("keeps temporary drawer preferences when persistence fails", async () => {
    const facade = createMockSkillLibraryFacade({ failDrawerSave: true });
    renderLibrary({ facade });

    await screen.findByRole("table");
    fireEvent.click(skillNameCell("PDF Reader"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Configure quick drawer" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Standard width" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Preference was not saved",
    );
    expect(screen.getByTestId("skill-quick-drawer")).toHaveAttribute(
      "data-preset",
      "standard",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const status = await screen.findByRole("status", {
      name: "Preference status",
    });
    expect(status).toHaveTextContent("Preference was not saved");
    fireEvent.click(within(status).getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(facade.calls.saveDrawerPreferences).toHaveLength(2);
    });
    fireEvent.click(
      within(
        await screen.findByRole("status", { name: "Preference status" }),
      ).getByRole("button", { name: "Restore default" }),
    );
    await waitFor(() => {
      expect(facade.calls.saveDrawerPreferences.at(-1)).toEqual(
        expect.objectContaining({ preset: "wide" }),
      );
    });
  });

  it("applies saved views without copying page state", async () => {
    const facade = createMockSkillLibraryFacade();
    const view = renderLibrary({
      facade,
      initialEntry: "/library?page=2&size=25",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Active" }));

    await waitFor(() => {
      expect(lastPageCall(facade)).toEqual(
        expect.objectContaining({
          filters: expect.objectContaining({ lifecycle: ["active"] }),
          page: 1,
          savedViewId: "active",
        }),
      );
    });
    expect(view.router.state.location.search).toContain("view=active");
    expect(view.router.state.location.search).not.toContain("page=2");
  });

  it("retains only explicit IDs that still match changed filters", async () => {
    const facade = createMockSkillLibraryFacade({
      matchingSkillIds: ["skill-pdf"],
    });
    const retain = vi.spyOn(facade, "retainMatchingSkillIds");
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select DOCX Writer" }));
    expect(screen.getByText("2 items selected")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
      target: { value: "reader" },
    });

    await waitFor(() => {
      expect(retain).toHaveBeenCalledWith(
        ["skill-docx", "skill-pdf"],
        expect.objectContaining({ text: "reader" }),
      );
      expect(screen.getByText("1 item selected")).toBeVisible();
    });
  });

  it("ignores stale explicit-selection retention results", async () => {
    const facade = createMockSkillLibraryFacade();
    let resolveFirst: ((ids: string[]) => void) | undefined;
    vi.spyOn(facade, "retainMatchingSkillIds")
      .mockImplementationOnce(
        () => new Promise<string[]>((resolve) => { resolveFirst = resolve; }),
      )
      .mockResolvedValueOnce(["skill-docx"]);
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select DOCX Writer" }));
    const search = screen.getByRole("searchbox", { name: "Search skills" });
    fireEvent.change(search, { target: { value: "reader" } });
    fireEvent.change(search, { target: { value: "writer" } });
    await waitFor(() => expect(screen.getByText("1 item selected")).toBeVisible());

    resolveFirst?.(["skill-pdf"]);
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "Select DOCX Writer" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Select PDF Reader" })).not.toBeChecked();
    });
  });

  it("switches drawer rows through reachable controls without rewriting URL context", async () => {
    const facade = createMockSkillLibraryFacade();
    const view = renderLibrary({
      facade,
      initialEntry: "/library?q=reader&page=2&size=25&future=preserve",
    });

    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select DOCX Writer" }));
    fireEvent.click(skillNameCell("PDF Reader"));
    expect(await screen.findByRole("dialog", { name: "PDF Reader" })).toBeVisible();
    expect(view.router.state.location.search).toBe(
      "?q=reader&page=2&size=25&future=preserve&skill=skill-pdf",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.getByRole("row", { name: /PDF Reader/ })).toHaveFocus();
    });
    expect(view.router.state.location.search).toBe(
      "?q=reader&page=2&size=25&future=preserve",
    );
    fireEvent.click(skillNameCell("Browser Automation"));

    expect(
      await screen.findByRole("dialog", { name: "Browser Automation" }),
    ).toBeVisible();
    expect(view.router.state.location.search).toBe(
      "?q=reader&page=2&size=25&future=preserve&skill=skill-browser",
    );
    expect(screen.getByText("1 item selected")).toBeVisible();
  });

  it("removes the batch bar when an all-filtered selection reaches zero", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select all 3 filtered results" }),
    );
    for (const name of ["PDF Reader", "DOCX Writer", "Browser Automation"]) {
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    }

    expect(
      screen.queryByRole("complementary", { name: "Batch actions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Run security check" }),
    ).not.toBeInTheDocument();
  });

  it("reserves the measured batch-bar height as actions wrap", async () => {
    let batchHeight = 72;
    let resizeCallback: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class MockResizeObserver implements ResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }

        disconnect() {}
        observe() {}
        unobserve() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        return DOMRect.fromRect({
          height: this.classList.contains("sh-skill-library__batch-bar")
            ? batchHeight
            : 0,
        });
      },
    );
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    const batchBar = screen.getByRole("complementary", {
      name: "Batch actions",
    });
    const workspace = batchBar.closest(".sh-skill-library");
    if (!(workspace instanceof HTMLElement)) {
      throw new Error("Expected the batch bar to be inside the Skill library workspace");
    }
    await waitFor(() => {
      expect(workspace).toHaveStyle("--skill-batch-bar-height: 72px");
    });
    expect(getComputedStyle(workspace).paddingBottom).toContain(
      "--skill-batch-bar-height",
    );

    batchHeight = 148;
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });
    expect(workspace).toHaveStyle("--skill-batch-bar-height: 148px");
    expect(getComputedStyle(batchBar).flexWrap).toBe("wrap");
  });

  it("reconnects batch clearance after a page error is retried", async () => {
    let batchHeight = 72;
    const activeObservers = new Set<MockResizeObserver>();
    class MockResizeObserver implements ResizeObserver {
      constructor(readonly callback: ResizeObserverCallback) {}

      disconnect() {
        activeObservers.delete(this);
      }

      observe() {
        activeObservers.add(this);
      }

      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        return DOMRect.fromRect({
          height: this.classList.contains("sh-skill-library__batch-bar")
            ? batchHeight
            : 0,
        });
      },
    );
    const facade = createMockSkillLibraryFacade();
    const successfulList = facade.listSkills.bind(facade);
    let pageAttempt = 0;
    vi.spyOn(facade, "listSkills").mockImplementation((query) => {
      pageAttempt += 1;
      return pageAttempt === 2
        ? Promise.reject(new Error("transient catalog read failure"))
        : successfulList(query);
    });
    const view = renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    const firstBatchBar = screen.getByRole("complementary", {
      name: "Batch actions",
    });
    const firstWorkspace = firstBatchBar.closest(".sh-skill-library");
    if (!(firstWorkspace instanceof HTMLElement)) {
      throw new Error("Expected the batch bar to be inside the Skill library workspace");
    }
    await waitFor(() => {
      expect(firstWorkspace).toHaveStyle("--skill-batch-bar-height: 72px");
    });

    await act(async () => {
      await view.queryClient.invalidateQueries({
        queryKey: ["skill-library", "page"],
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load the skill library",
    );
    expect(firstBatchBar.isConnected).toBe(false);
    batchHeight = 96;
    act(() => {
      for (const observer of activeObservers) {
        observer.callback([], observer);
      }
    });
    expect(
      firstWorkspace.style.getPropertyValue("--skill-batch-bar-height"),
    ).toBe("");

    batchHeight = 124;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const nextBatchBar = await screen.findByRole("complementary", {
      name: "Batch actions",
    });
    const nextWorkspace = nextBatchBar.closest(".sh-skill-library");
    if (!(nextWorkspace instanceof HTMLElement)) {
      throw new Error("Expected the retried batch bar to be inside the workspace");
    }
    await waitFor(() => {
      expect(nextWorkspace).toHaveStyle("--skill-batch-bar-height: 124px");
    });

    batchHeight = 168;
    act(() => {
      for (const observer of activeObservers) {
        observer.callback([], observer);
      }
    });
    expect(nextWorkspace).toHaveStyle("--skill-batch-bar-height: 168px");
  });

  it("saves only the view scope and current table preferences", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade, initialEntry: "/library?q=pdf&page=2" });

    fireEvent.click(
      await screen.findByRole("button", { name: "Save current view" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Document readers" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));

    await waitFor(() => {
      expect(facade.calls.saveView).toContainEqual({
        name: "Document readers",
        query: {
          filters: expect.any(Object),
          sort: { column: "name", direction: "asc" },
          text: "pdf",
        },
        table: expect.any(Object),
      });
    });
    expect(screen.queryByText("View saved")).not.toBeInTheDocument();
  });

  it("shows and activates a saved shortcut after saving the current filters", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade, initialEntry: "/library?deployment=deployed" });

    fireEvent.click(
      await screen.findByRole("button", { name: "Save current view" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Deployed skills" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));

    const savedView = await screen.findByRole("button", { name: "Deployed skills" });
    expect(savedView).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("deletes custom saved views while keeping built-in views available", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    await screen.findByRole("button", { name: "Document tools" });
    expect(screen.queryByRole("button", { name: "Delete Active" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete Document tools" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Document tools" })).not.toBeInTheDocument();
      expect(facade.calls.deleteView).toEqual(["documents"]);
    });
  });

  it("keeps the built-in attention view clean immediately after applying it", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    fireEvent.click(await screen.findByRole("button", { name: "Needs attention" }));

    await waitFor(() => {
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    });
  });

  it("keeps a rejected saved-view form recoverable until a later save succeeds", async () => {
    const facade = createMockSkillLibraryFacade();
    const savedViewsRead = vi.spyOn(facade, "listSavedViews");
    const firstSave = deferred<SavedSkillView>();
    const successfulSave = facade.saveView.bind(facade);
    const saveView = vi
      .spyOn(facade, "saveView")
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementation((view) => successfulSave(view));
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("button", { name: "Save current view" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Recovery view" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));

    expect(screen.getByRole("button", { name: "Save view" })).toBeDisabled();
    expect(saveView).toHaveBeenCalledTimes(1);
    await act(async () => {
      firstSave.reject(new Error("saved view write failed"));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The view could not be saved",
    );
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue(
      "Recovery view",
    );
    expect(screen.getByRole("button", { name: "Save view" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Recovery view" })).not.toBeInTheDocument();
    expect(screen.queryByText("View saved")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save view" }));

    await waitFor(() => {
      expect(saveView).toHaveBeenCalledTimes(2);
      expect(savedViewsRead).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByRole("form", { name: "Save current view" }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps built-in views usable while a saved-view read recovers", async () => {
    const facade = createMockSkillLibraryFacade();
    const listSavedViews = facade.listSavedViews.bind(facade);
    const savedViewsRead = vi
      .spyOn(facade, "listSavedViews")
      .mockRejectedValueOnce(new Error("saved views unavailable"))
      .mockImplementation(() => listSavedViews());
    renderLibrary({ facade });

    expect(await screen.findByRole("table")).toBeVisible();
    const status = screen.getByRole("status", { name: "Preference status" });
    expect(status).toHaveTextContent("Saved views could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    await waitFor(() => {
      expect(lastPageCall(facade)).toEqual(
        expect.objectContaining({
          filters: expect.objectContaining({ lifecycle: ["active"] }),
        }),
      );
    });

    fireEvent.click(within(status).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "Document tools" })).toBeVisible();
    expect(savedViewsRead).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("status", { name: "Preference status" }),
    ).not.toBeInTheDocument();
  });

  it("uses default drawer preferences while a failed read retries server preferences", async () => {
    const facade = createMockSkillLibraryFacade();
    const serverPreferences: SkillDrawerPreferences = {
      moduleOrder: [
        "identity",
        "primary_actions",
        "risk_summary",
        "full_details",
        "versions",
      ],
      preset: "standard",
      visibleModules: [
        "identity",
        "primary_actions",
        "risk_summary",
        "full_details",
        "versions",
      ],
      widthPx: 480,
    };
    const drawerPreferencesRead = vi
      .spyOn(facade, "loadDrawerPreferences")
      .mockRejectedValueOnce(new Error("drawer preferences unavailable"))
      .mockResolvedValue(serverPreferences);
    renderLibrary({ facade });

    expect(await screen.findByRole("table")).toBeVisible();
    const status = screen.getByRole("status", { name: "Preference status" });
    expect(status).toHaveTextContent("Drawer preferences could not be loaded");
    fireEvent.click(skillNameCell("PDF Reader"));
    expect(await screen.findByTestId("skill-quick-drawer")).toHaveAttribute(
      "data-preset",
      "wide",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(within(status).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(drawerPreferencesRead).toHaveBeenCalledTimes(2));
    fireEvent.click(skillNameCell("PDF Reader"));

    expect(await screen.findByTestId("skill-quick-drawer")).toHaveAttribute(
      "data-preset",
      "standard",
    );
    expect(screen.getByTestId("skill-quick-drawer")).toHaveStyle(
      "--skill-drawer-width: 480px",
    );
    expect(
      screen.queryByRole("status", { name: "Preference status" }),
    ).not.toBeInTheDocument();
  });

  it("invalidates and refetches drawer preferences after a failed save retry succeeds", async () => {
    const facade = createMockSkillLibraryFacade();
    const drawerPreferencesRead = vi.spyOn(facade, "loadDrawerPreferences");
    const saveDrawerPreferences = vi
      .spyOn(facade, "saveDrawerPreferences")
      .mockRejectedValueOnce(new Error("drawer preference save failed"))
      .mockResolvedValue(undefined);
    renderLibrary({ facade });

    await screen.findByRole("table");
    fireEvent.click(skillNameCell("PDF Reader"));
    fireEvent.click(await screen.findByRole("button", { name: "Standard width" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Preference was not saved",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const status = await screen.findByRole("status", {
      name: "Preference status",
    });

    fireEvent.click(within(status).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(saveDrawerPreferences).toHaveBeenCalledTimes(2);
      expect(drawerPreferencesRead).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByRole("status", { name: "Preference status" }),
      ).not.toBeInTheDocument();
    });
    fireEvent.click(skillNameCell("PDF Reader"));
    expect(await screen.findByTestId("skill-quick-drawer")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains unavailable batch workflows without inventing completion", async () => {
    const facade = createMockSkillLibraryFacade();
    vi.spyOn(facade, "emitBatchIntent").mockRejectedValue(
      new SkillLibraryUnavailableError(),
    );
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "This batch workflow is not connected",
    );
    expect(screen.queryByText("Export completed")).not.toBeInTheDocument();
  });

  it("clears a failed batch announcement when the selected scope changes", async () => {
    const facade = createMockSkillLibraryFacade();
    vi.spyOn(facade, "emitBatchIntent").mockRejectedValue(
      new Error("batch preparation failed"),
    );
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const batchBar = screen.getByRole("complementary", { name: "Batch actions" });
    expect(await within(batchBar).findByRole("status")).toHaveTextContent(
      "The batch workflow could not be started",
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select DOCX Writer" }));

    expect(within(batchBar).getByText("2 items selected")).toBeVisible();
    expect(within(batchBar).queryByRole("status")).not.toBeInTheDocument();
    expect(
      within(batchBar).queryByText("The batch workflow could not be started"),
    ).not.toBeInTheDocument();
  });

  it("keeps valid table data when preference reads fail and lets the user retry", async () => {
    const facade = createMockSkillLibraryFacade();
    const tablePreferences = vi
      .spyOn(facade, "loadTablePreferences")
      .mockRejectedValueOnce(new Error("settings unavailable"))
      .mockResolvedValueOnce({
        columnOrder: ["select", "name"],
        density: "compact",
        visibleColumns: ["select", "name"],
      });
    renderLibrary({ facade });

    expect(await screen.findByRole("table")).toBeVisible();
    const status = screen.getByRole("status", { name: "Preference status" });
    expect(status).toHaveTextContent("Table preferences could not be loaded");
    fireEvent.click(within(status).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(tablePreferences).toHaveBeenCalledTimes(2));
  });
});
