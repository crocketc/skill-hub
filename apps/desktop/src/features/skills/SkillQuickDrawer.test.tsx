import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import "../../styles/base.css";
import {
  DEFAULT_DRAWER_PREFERENCES,
  DEFAULT_TABLE_PREFERENCES,
  type SkillBatchIntent,
  type SkillDrawerPreferences,
  type SkillLibraryFacade,
  type SkillQuickView,
} from "./api";
import {
  clampDrawerWidth,
  drawerWidthForPreset,
  normalizeDrawerPreferences,
  reorderDrawerModule,
} from "./drawerModules";
import { SkillQuickDrawer } from "./SkillQuickDrawer";
import type { SkillLibraryReturnState } from "../skill-detail/detailContext";

const QUICK_VIEW: SkillQuickView = {
  aiCheck: "unavailable",
  agentDeploymentCount: 2,
  alias: "reader",
  basicCheck: "passed",
  currentVersion: "1.4.0",
  dependencies: ["pymupdf"],
  duplicateCandidates: ["document-reader"],
  externalChanges: ["SKILL.md changed outside SkillHub"],
  highRiskCount: 2,
  id: "skill-pdf",
  invocation: "pdf-reader <file>",
  license: "MIT",
  lifecycle: "active",
  name: "PDF Reader",
  originalDescription: "Extracts text from PDF files.",
  ownership: "Platform team",
  pendingCount: 1,
  projectDeploymentCount: 3,
  purpose: "Read and extract PDFs",
  requirements: ["Python 3.11"],
  source: "Internal catalog",
  tags: ["documents", "pdf"],
  translatedDescription: "Reads PDF files.",
  upgradeAvailable: true,
  usageEvidence: { invocationCount: 12, lastUsedAt: "2026-08-24T10:00:00Z" },
  note: "Keep this reader near document workflows.",
};

interface MockOptions {
  failDrawerSave?: boolean;
  failQuickView?: boolean;
  quickView?: SkillQuickView;
  quickViewPromise?: Promise<SkillQuickView>;
  saveDrawerPreference?: (
    preferences: SkillDrawerPreferences,
    index: number,
  ) => Promise<void>;
  saveSkillMetadata?: (patch: { alias?: string | null; note?: string | null }) => Promise<void>;
  usageEvidence?: SkillQuickView["usageEvidence"];
}

interface MockFacade extends SkillLibraryFacade {
  calls: {
    deleteView: string[];
    emitBatchIntent: SkillBatchIntent[];
    getSkillQuickView: string[];
    saveDrawerPreferences: SkillDrawerPreferences[];
    saveSkillMetadata: Array<{ skillId: string; patch: { alias?: string | null; note?: string | null } }>;
  };
}

function clonePreferences(
  preferences: SkillDrawerPreferences,
): SkillDrawerPreferences {
  return {
    ...preferences,
    moduleOrder: [...preferences.moduleOrder],
    visibleModules: [...preferences.visibleModules],
  };
}

function createMockSkillLibraryFacade(options: MockOptions = {}): MockFacade {
  const calls: MockFacade["calls"] = {
    deleteView: [],
    emitBatchIntent: [],
    getSkillQuickView: [],
    saveDrawerPreferences: [],
    saveSkillMetadata: [],
  };
  return {
    calls,
    async emitBatchIntent(intent) {
      calls.emitBatchIntent.push(intent);
    },
    async getSkillQuickView(skillId) {
      calls.getSkillQuickView.push(skillId);
      if (options.failQuickView) {
        throw new Error("detail read failed");
      }
      if (options.quickViewPromise) {
        return options.quickViewPromise;
      }
      if (options.quickView) {
        return options.quickView;
      }
      return {
        ...QUICK_VIEW,
        usageEvidence:
          "usageEvidence" in options
            ? options.usageEvidence
            : QUICK_VIEW.usageEvidence,
      };
    },
    async listSavedViews() {
      return [];
    },
    async deleteView() {
      return undefined;
    },
    async listSkills() {
      return { facets: { tags: [] }, items: [], page: 1, pageSize: 25, total: 0 };
    },
    async loadDrawerPreferences() {
      return clonePreferences(DEFAULT_DRAWER_PREFERENCES);
    },
    async loadTablePreferences() {
      return DEFAULT_TABLE_PREFERENCES;
    },
    async retainMatchingSkillIds() {
      return [];
    },
    async saveDrawerPreferences(preferences) {
      const savedPreferences = clonePreferences(preferences);
      calls.saveDrawerPreferences.push(savedPreferences);
      if (options.saveDrawerPreference) {
        await options.saveDrawerPreference(
          savedPreferences,
          calls.saveDrawerPreferences.length - 1,
        );
      }
      if (options.failDrawerSave) {
        throw new Error("preference write failed");
      }
    },
    async saveSkillMetadata(skillId, patch) {
      calls.saveSkillMetadata.push({ skillId, patch });
      await options.saveSkillMetadata?.(patch);
    },
    async saveTablePreferences() {
      return undefined;
    },
    async saveView(view) {
      return { builtIn: false, id: "saved", ...view };
    },
  };
}

interface DrawerHarnessProps {
  detailSearch?: string;
  facade: SkillLibraryFacade;
  libraryReturn?: SkillLibraryReturnState;
  open?: boolean;
  preferences?: SkillDrawerPreferences;
  skillId?: string;
}

function DrawerHarness({
  detailSearch,
  facade,
  libraryReturn,
  open = true,
  preferences = DEFAULT_DRAWER_PREFERENCES,
  skillId = "skill-pdf",
}: DrawerHarnessProps) {
  const [controlledPreferences, setControlledPreferences] = useState(() =>
    clonePreferences(preferences),
  );
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={returnFocusRef} type="button">
        PDF Reader row
      </button>
      <SkillQuickDrawer
        detailSearch={detailSearch}
        facade={facade}
        libraryReturn={libraryReturn}
        onOpenChange={() => undefined}
        onPreferencesChange={setControlledPreferences}
        open={open}
        preferences={controlledPreferences}
        returnFocusRef={returnFocusRef}
        skillId={skillId}
      />
    </>
  );
}

interface RenderDrawerOptions extends DrawerHarnessProps {
  initialEntry?: string;
  viewportWidth?: number;
}

async function renderDrawer({
  initialEntry = "/library",
  viewportWidth = 1200,
  ...props
}: RenderDrawerOptions) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: viewportWidth,
  });
  const i18n = await createSkillHubI18n(["en-US"]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <DrawerHarness {...props} />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { client };
}

function pendingQuickView() {
  return new Promise<SkillQuickView>(() => undefined);
}

function deferred<T = void>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function mockReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? reduced : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function mockPointerEvents() {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("drawer preference helpers", () => {
  it("restores required modules and removes unknown and duplicate values", () => {
    const normalized = normalizeDrawerPreferences({
      moduleOrder: ["relations", "relations", "unknown", "identity"],
      preset: "wide",
      visibleModules: ["relations", "unknown"],
      widthPx: 680,
    } as SkillDrawerPreferences);

    expect(normalized.moduleOrder.slice(0, 2)).toEqual(["relations", "identity"]);
    expect(normalized.moduleOrder).toHaveLength(12);
    expect(normalized.visibleModules).toEqual(
      expect.arrayContaining(["identity", "primary_actions", "risk_summary", "full_details"]),
    );
    expect(new Set(normalized.moduleOrder).size).toBe(normalized.moduleOrder.length);
  });

  it("reorders modules immutably and clamps preset widths", () => {
    const order = ["relations", "versions", "source_license"] as const;
    expect(reorderDrawerModule([...order], "versions", "relations")).toEqual([
      "versions",
      "relations",
      "source_license",
    ]);
    expect(order).toEqual(["relations", "versions", "source_license"]);
    expect(drawerWidthForPreset("standard", 1200)).toBe(480);
    expect(drawerWidthForPreset("wide", 1200)).toBe(680);
    expect(drawerWidthForPreset("near_full", 1200)).toBe(1152);
    expect(clampDrawerWidth(300, 1200)).toBe(420);
    expect(clampDrawerWidth(1400, 1200)).toBe(1168);
  });
});

it("keeps required modules visible while toggling and reordering modules", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });
  fireEvent.click(
    await screen.findByRole("button", { name: "Configure quick drawer" }),
  );
  expect(screen.getByRole("button", { name: "Identity" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Risk summary" })).toBeDisabled();
  const relations = screen.getByRole("button", { name: "Relations" });
  expect(relations).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(relations);
  expect(relations).toHaveAttribute("aria-pressed", "false");

  const versions = screen.getByRole("button", { name: "Versions" });
  fireEvent.dragStart(versions);
  fireEvent.dragOver(relations);
  fireEvent.drop(relations);
  await waitFor(() => {
    const order = facade.calls.saveDrawerPreferences.at(-1)!.moduleOrder;
    expect(order.indexOf("versions")).toBeLessThan(order.indexOf("relations"));
  });

  fireEvent.dragStart(relations);
  fireEvent.dragOver(versions);
  fireEvent.drop(versions);
  await waitFor(() => {
    const order = facade.calls.saveDrawerPreferences.at(-1)!.moduleOrder;
    expect(order.indexOf("relations")).toBeGreaterThan(order.indexOf("versions"));
  });
});

it("starts wide, changes presets, and persists a clamped drag width", async () => {
  mockPointerEvents();
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade, viewportWidth: 1200 });
  expect(await screen.findByTestId("skill-quick-drawer")).toHaveStyle(
    "--skill-drawer-width: 680px",
  );
  fireEvent.click(screen.getByRole("button", { name: "Near full screen" }));
  await waitFor(() => {
    expect(facade.calls.saveDrawerPreferences).toHaveLength(1);
  });
  const separator = screen.getByRole("separator", { name: "Resize quick drawer" });
  fireEvent.pointerDown(separator, { clientX: 500, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 420, pointerId: 1 });
  expect(facade.calls.saveDrawerPreferences).toHaveLength(1);
  fireEvent.pointerUp(window, { pointerId: 1 });
  await waitFor(() => {
    expect(facade.calls.saveDrawerPreferences.at(-1)?.widthPx).toBeGreaterThanOrEqual(420);
    expect(facade.calls.saveDrawerPreferences).toHaveLength(2);
  });
});

it("resizes the focused separator with Arrow, Home, and End keys", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade, viewportWidth: 1200 });
  const separator = screen.getByRole("separator", { name: "Resize quick drawer" });

  separator.focus();
  expect(separator).toHaveFocus();
  expect(separator).toHaveAttribute("tabindex", "0");
  expect(separator).toHaveAttribute("aria-valuemin", "420");
  expect(separator).toHaveAttribute("aria-valuemax", "1168");
  expect(separator).toHaveAttribute("aria-valuenow", "680");

  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator).toHaveAttribute("aria-valuenow", "696");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(separator).toHaveAttribute("aria-valuenow", "680");
  fireEvent.keyDown(separator, { key: "Home" });
  expect(separator).toHaveAttribute("aria-valuenow", "420");
  fireEvent.keyDown(separator, { key: "End" });
  expect(separator).toHaveAttribute("aria-valuenow", "1168");

  await waitFor(() => {
    expect(facade.calls.saveDrawerPreferences.map(({ widthPx }) => widthPx)).toEqual([
      696,
      680,
      420,
      1168,
    ]);
  });
});

it("clamps a persisted width before rendering in a narrower viewport", async () => {
  mockPointerEvents();
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({
    facade,
    preferences: { ...DEFAULT_DRAWER_PREFERENCES, widthPx: 1100 },
    viewportWidth: 600,
  });

  const separator = screen.getByRole("separator", { name: "Resize quick drawer" });
  expect(await screen.findByTestId("skill-quick-drawer")).toHaveStyle(
    "--skill-drawer-width: 568px",
  );
  expect(separator).toHaveAttribute("aria-valuemax", "568");
  expect(separator).toHaveAttribute("aria-valuenow", "568");

  fireEvent.pointerDown(separator, { clientX: 500, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 520, pointerId: 1 });
  expect(screen.getByTestId("skill-quick-drawer")).toHaveStyle(
    "--skill-drawer-width: 548px",
  );
  fireEvent.pointerCancel(window, { pointerId: 1 });
});

it.each(["pointercancel", "lostpointercapture"] as const)(
  "cleans up %s without persisting the cancelled drag",
  async (eventType) => {
    mockPointerEvents();
    const facade = createMockSkillLibraryFacade();
    await renderDrawer({ facade, viewportWidth: 1200 });
    const drawer = await screen.findByTestId("skill-quick-drawer");
    const separator = screen.getByRole("separator", { name: "Resize quick drawer" });

    fireEvent.pointerDown(separator, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 });
    expect(drawer).toHaveStyle("--skill-drawer-width: 780px");

    const cancelTarget = eventType === "pointercancel" ? window : separator;
    fireEvent(
      cancelTarget,
      new PointerEvent(eventType, { bubbles: true, pointerId: 1 }),
    );
    expect(drawer).toHaveStyle("--skill-drawer-width: 680px");

    fireEvent.pointerMove(window, { clientX: 300, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    await waitFor(() => {
      expect(facade.calls.saveDrawerPreferences).toEqual([]);
      expect(drawer).toHaveStyle("--skill-drawer-width: 680px");
    });
  },
);

it("serializes overlapping saves and ignores an older rejected result", async () => {
  const firstSave = deferred();
  const secondSave = deferred();
  const facade = createMockSkillLibraryFacade({
    saveDrawerPreference: async (_preferences, index) =>
      index === 0 ? firstSave.promise : secondSave.promise,
  });
  await renderDrawer({ facade });

  fireEvent.click(screen.getByRole("button", { name: "Standard width" }));
  fireEvent.click(screen.getByRole("button", { name: "Near full screen" }));
  await waitFor(() => {
    expect(facade.calls.saveDrawerPreferences).toHaveLength(1);
  });

  firstSave.reject(new Error("older save failed"));
  await waitFor(() => {
    expect(facade.calls.saveDrawerPreferences).toHaveLength(2);
  });
  expect(screen.queryByText(/Preference was not saved/)).not.toBeInTheDocument();
  secondSave.resolve();
  await waitFor(() => {
    expect(screen.queryByText(/Preference was not saved/)).not.toBeInTheDocument();
    expect(screen.getByTestId("skill-quick-drawer")).toHaveAttribute(
      "data-preset",
      "near_full",
    );
  });
});

it("keeps temporary preferences visible when persistence fails", async () => {
  const facade = createMockSkillLibraryFacade({ failDrawerSave: true });
  await renderDrawer({ facade });
  fireEvent.click(await screen.findByRole("button", { name: "Standard width" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Preference was not saved",
  );
  expect(screen.getByTestId("skill-quick-drawer")).toHaveAttribute(
    "data-preset",
    "standard",
  );
});

it("shows the detail loading state", async () => {
  const loadingFacade = createMockSkillLibraryFacade({
    quickViewPromise: pendingQuickView(),
  });
  await renderDrawer({ facade: loadingFacade });
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Loading skill details",
  );
});

it("shows the detail error state", async () => {
  const failingFacade = createMockSkillLibraryFacade({ failQuickView: true });
  await renderDrawer({ facade: failingFacade });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load skill details",
  );
});

it("shows agent tags and project names with paths in the relations module", async () => {
  const facade = createMockSkillLibraryFacade({
    quickView: {
      ...QUICK_VIEW,
      agentDeployments: [
        { id: "codex", name: "OpenAI Codex" },
        { id: "claude", name: "Claude Code" },
      ],
      projectDeployments: [
        { id: "project-docs", name: "Document workflows", path: "C:\\workspace\\docs" },
        { id: "project-ops", name: "Operations", path: "C:\\workspace\\ops" },
      ],
    } as SkillQuickView,
  });
  await renderDrawer({ facade });

  expect(await screen.findByText("Codex")).toBeVisible();
  expect(screen.getByText("Claude")).toBeVisible();
  expect(screen.getByText("Document workflows")).toBeVisible();
  expect(screen.getByText("C:\\workspace\\docs")).toBeVisible();
  expect(screen.getByText("Operations")).toBeVisible();
  expect(screen.getByText("C:\\workspace\\ops")).toBeVisible();
});

it("limits long project relations and expands the remaining entries on demand", async () => {
  const facade = createMockSkillLibraryFacade({
    quickView: {
      ...QUICK_VIEW,
      projectDeployments: Array.from({ length: 5 }, (_, index) => ({
        id: `project-${index + 1}`,
        name: `Project ${index + 1}`,
        path: `C:\\workspace\\project-${index + 1}`,
      })),
    } as SkillQuickView,
  });
  await renderDrawer({ facade });

  expect(await screen.findByText("Project 1")).toBeVisible();
  expect(screen.getByText("Project 3")).toBeVisible();
  expect(screen.queryByText("Project 4")).not.toBeInTheDocument();
  const expand = screen.getByRole("button", { name: /Show 2 more projects/ });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(expand);
  expect(screen.getByText("Project 5")).toBeVisible();
  expect(expand).toHaveAttribute("aria-expanded", "true");
});

it("resets defaults, keeps modules independently scrollable, and links to full details", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });
  const drawer = await screen.findByRole("dialog", { name: "PDF Reader" });
  expect(drawer.querySelector(".sh-drawer__header")).not.toBeInTheDocument();
  fireEvent.click(
    await screen.findByRole("button", { name: "Configure quick drawer" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Relations" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  await waitFor(() => {
    expect(facade.calls.saveDrawerPreferences.at(-1)).toEqual(
      clonePreferences(DEFAULT_DRAWER_PREFERENCES),
    );
  });
  expect(getComputedStyle(screen.getByTestId("drawer-modules-scroll")).overflowY).toBe(
    "auto",
  );
  expect(screen.getByRole("link", { name: "View and edit full details" })).toHaveAttribute(
    "href",
    "/library/skill-pdf",
  );
  expect(document.querySelector(".sh-skill-drawer__toolbar a")).toBe(
    screen.getByRole("link", { name: "View and edit full details" }),
  );
  expect(screen.getByRole("link", { name: "View and edit full details" })).toHaveClass(
    "sh-button--primary",
  );
  const toolbar = document.querySelector(".sh-skill-drawer__toolbar");
  expect(toolbar?.firstElementChild).toContainElement(
    screen.getByRole("link", { name: "View and edit full details" }),
  );
  expect(toolbar?.lastElementChild).toContainElement(
    screen.getByRole("button", { name: "Configure quick drawer" }),
  );
  expect(toolbar?.lastElementChild).toContainElement(
    screen.getByRole("button", { name: "Close" }),
  );
  expect(screen.getByRole("button", { name: "Standard width" })).toHaveClass(
    "sh-skill-drawer__preset-icon-button",
  );
  expect(
    getComputedStyle(
      screen.getByRole("button", { name: "Standard width" }).querySelector("span")!,
    ).getPropertyValue("--preset-line-position"),
  ).toBe("75%");
  expect(
    getComputedStyle(
      screen.getByRole("button", { name: "Near full screen" }).querySelector("span")!,
    ).getPropertyValue("--preset-line-position"),
  ).toBe("25%");
});

it("carries the library query and return position into full details", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({
    detailSearch: "?q=pdf&sort=version%3Adesc",
    facade,
    libraryReturn: { focusSkillId: "skill-pdf", scrollLeft: 24, scrollTop: 416 },
  });
  expect(await screen.findByRole("link", { name: "View and edit full details" })).toHaveAttribute(
    "href",
    "/library/skill-pdf?q=pdf&sort=version%3Adesc",
  );
});

it("keeps preview full-detail links inside the development preview routes", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade, initialEntry: "/__preview/skill-library" });

  expect(await screen.findByRole("link", { name: "View and edit full details" })).toHaveAttribute(
    "href",
    "/__preview/skill-detail/skill-pdf",
  );
});

it("inherits reduced motion and emits only a single-skill action intent", async () => {
  mockReducedMotion(true);
  const facade = createMockSkillLibraryFacade({ usageEvidence: undefined });
  await renderDrawer({ facade });
  expect(await screen.findByTestId("drawer-panel")).toHaveAttribute(
    "data-reduced-motion",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Add to" }));
  await waitFor(() => {
    expect(facade.calls.emitBatchIntent).toContainEqual({
      action: "add_to",
      target: { kind: "skill_ids", skillIds: ["skill-pdf"] },
    });
  });
  expect(screen.queryByText(/completed/i)).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Usage evidence" })).toBeVisible();
  expect(screen.queryByText(/0 invocations/i)).not.toBeInTheDocument();
});

it("offers single-skill tag actions and saves alias and note edits on blur", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });

  expect(await screen.findByRole("button", { name: "Add tags" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Remove tags" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Add tags" }));
  const dialog = await screen.findByRole("dialog", { name: "Add tags" });
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

  fireEvent.click(screen.getByRole("button", { name: "Edit alias" }));
  const aliasInput = screen.getByRole("textbox", { name: "Alias" });
  fireEvent.change(aliasInput, { target: { value: "PDF helper" } });
  fireEvent.blur(aliasInput);
  await waitFor(() => {
    expect(facade.calls.saveSkillMetadata).toContainEqual({
      skillId: "skill-pdf",
      patch: { alias: "PDF helper" },
    });
  });
  expect(screen.getByText("PDF helper")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
  const noteInput = screen.getByRole("textbox", { name: "My note" });
  fireEvent.change(noteInput, { target: { value: "Use for invoices" } });
  fireEvent.blur(noteInput);
  await waitFor(() => {
    expect(facade.calls.saveSkillMetadata).toContainEqual({
      skillId: "skill-pdf",
      patch: { note: "Use for invoices" },
    });
  });
  expect(screen.getByText("Use for invoices")).toBeVisible();
});

it("labels drawer identity fields in source-first and user-metadata order", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });

  const drawer = await screen.findByTestId("skill-quick-drawer");
  const identity = within(drawer).getByRole("heading", { name: "PDF Reader" });
  const region = identity.closest(".sh-skill-drawer__identity");
  expect(region).toBeInTheDocument();

  const originalDescription = within(region as HTMLElement).getByText(/Original description/);
  const purpose = within(region as HTMLElement).getByText(/My purpose/);
  const note = within(region as HTMLElement).getByText(/My note/);
  expect(originalDescription).toBeVisible();
  expect(within(region as HTMLElement).getByText("Extracts text from PDF files.")).toBeVisible();
  expect(purpose).toBeVisible();
  expect(note).toBeVisible();
  expect(originalDescription.compareDocumentPosition(purpose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(purpose.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("does not fetch details while the drawer is disabled", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade, open: false });
  await waitFor(() => {
    expect(facade.calls.getSkillQuickView).toEqual([]);
  });
});
