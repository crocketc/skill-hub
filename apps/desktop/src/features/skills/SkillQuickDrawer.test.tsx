import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
};

interface MockOptions {
  failDrawerSave?: boolean;
  failQuickView?: boolean;
  quickViewPromise?: Promise<SkillQuickView>;
  usageEvidence?: SkillQuickView["usageEvidence"];
}

interface MockFacade extends SkillLibraryFacade {
  calls: {
    emitBatchIntent: SkillBatchIntent[];
    getSkillQuickView: string[];
    saveDrawerPreferences: SkillDrawerPreferences[];
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
    emitBatchIntent: [],
    getSkillQuickView: [],
    saveDrawerPreferences: [],
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
      calls.saveDrawerPreferences.push(clonePreferences(preferences));
      if (options.failDrawerSave) {
        throw new Error("preference write failed");
      }
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
  facade: SkillLibraryFacade;
  open?: boolean;
  preferences?: SkillDrawerPreferences;
  skillId?: string;
}

function DrawerHarness({
  facade,
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
        facade={facade}
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
  viewportWidth?: number;
}

async function renderDrawer({
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
        <MemoryRouter>
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

it("keeps required modules visible while reordering optional modules", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });
  fireEvent.click(
    await screen.findByRole("button", { name: "Configure quick drawer" }),
  );
  expect(screen.getByRole("checkbox", { name: "Identity" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "Risk summary" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Move versions before relations" }),
  );
  await waitFor(() => {
    const order = facade.calls.saveDrawerPreferences.at(-1)!.moduleOrder;
    expect(order.indexOf("versions")).toBeLessThan(order.indexOf("relations"));
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

it("resets defaults, keeps modules independently scrollable, and links to full details", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });
  fireEvent.click(
    await screen.findByRole("button", { name: "Configure quick drawer" }),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Relations" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  await waitFor(() => {
    expect(facade.calls.saveDrawerPreferences.at(-1)).toEqual(
      clonePreferences(DEFAULT_DRAWER_PREFERENCES),
    );
  });
  expect(getComputedStyle(screen.getByTestId("drawer-modules-scroll")).overflowY).toBe(
    "auto",
  );
  expect(screen.getByRole("link", { name: "View full details" })).toHaveAttribute(
    "href",
    "/library/skill-pdf",
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
  expect(screen.queryByText("Usage evidence")).not.toBeInTheDocument();
  expect(screen.queryByText(/0 invocations/i)).not.toBeInTheDocument();
});

it("does not fetch details while the drawer is disabled", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade, open: false });
  await waitFor(() => {
    expect(facade.calls.getSkillQuickView).toEqual([]);
  });
});
