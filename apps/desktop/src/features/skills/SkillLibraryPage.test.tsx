import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryRouter,
  RouterProvider,
} from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { skillHubI18n } from "../../i18n";
import "../../styles/base.css";
import {
  SkillLibraryUnavailableError,
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
  initialEntry?: string;
}

interface RenderedLibrary {
  queryClient: QueryClient;
  router: ReturnType<typeof createMemoryRouter>;
}

function renderLibrary({
  facade,
  initialEntry = "/library",
}: RenderLibraryOptions): RenderedLibrary {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SkillLibraryPage", () => {
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
      await screen.findByText("The local catalog contract is not connected"),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
