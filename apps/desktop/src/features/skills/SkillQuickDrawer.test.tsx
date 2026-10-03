import userEvent2 from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { separateCheckFixture, type SecurityFacade } from "../security/api";
import { createPreviewSecurityFacade } from "../security/previewFacade";
import "../../styles/base.css";
import {
  DEFAULT_DRAWER_PREFERENCES,
  DEFAULT_SKILL_QUERY,
  DEFAULT_TABLE_PREFERENCES,
  skillLibraryKeys,
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
  saveSkillMetadata?: (patch: { alias?: string | null; note?: string | null; tags?: string[] }) => Promise<void>;
  usageEvidence?: SkillQuickView["usageEvidence"];
}

interface TrialFacade {
  setTrial: (skillId: string, due: string | null) => Promise<void>;
}

interface MockFacade extends SkillLibraryFacade {
  calls: {
    deleteView: string[];
    emitBatchIntent: SkillBatchIntent[];
    getSkillQuickView: string[];
    listSkills: number;
    saveDrawerPreferences: SkillDrawerPreferences[];
    saveSkillMetadata: Array<{ skillId: string; patch: { alias?: string | null; note?: string | null; tags?: string[] } }>;
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
    listSkills: 0,
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
      calls.listSkills += 1;
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
  onDelete?: (skillId: string, skillName: string) => void;
  trialFacade?: TrialFacade;
  open?: boolean;
  preferences?: SkillDrawerPreferences;
  refreshSnapshot?: () => Promise<void>;
  securityFacade?: SecurityFacade;
  skillId?: string;
}

function DrawerHarness({
  detailSearch,
  facade,
  libraryReturn,
  onDelete,
  trialFacade,
  open = true,
  preferences = DEFAULT_DRAWER_PREFERENCES,
  refreshSnapshot,
  securityFacade,
  skillId = "skill-pdf",
}: DrawerHarnessProps & {
  onDelete?: (skillId: string, skillName: string) => void;
}) {
  const [controlledPreferences, setControlledPreferences] = useState(() =>
    clonePreferences(preferences),
  );
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  // 探针：让技能库列表查询在抽屉测试中真实存在，用于断言元数据保存后的缓存失效。
  useQuery({ queryFn: () => facade.listSkills(DEFAULT_SKILL_QUERY), queryKey: skillLibraryKeys.root });
  return (
    <>
      <button ref={returnFocusRef} type="button">
        PDF Reader row
      </button>
      <SkillQuickDrawer
        detailSearch={detailSearch}
        facade={facade}
        libraryReturn={libraryReturn}
        onDelete={onDelete}
        trialFacade={trialFacade}
        onOpenChange={() => undefined}
        onPreferencesChange={setControlledPreferences}
        open={open}
        preferences={controlledPreferences}
        refreshSnapshot={refreshSnapshot}
        securityFacade={securityFacade ?? createPreviewSecurityFacade()}
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
  if (reduced) localStorage.setItem("skillhub.reduced-motion", "true");
  else localStorage.removeItem("skillhub.reduced-motion");
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
  localStorage.removeItem("skillhub.reduced-motion");
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

it("starts wide, changes presets, and persists a clamped drag width", async () => {
  mockPointerEvents();
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade, viewportWidth: 1200 });
  expect(await screen.findByTestId("skill-quick-drawer")).toHaveStyle(
    "--skill-drawer-width: 680px",
  );
  fireEvent.click(screen.getByRole("button", { name: "Current width: Wide. Next: Near full screen" }));
  await waitFor(() => {
    expect(facade.calls.saveDrawerPreferences).toHaveLength(1);
  });
  const separator = screen.getByRole("separator", { name: "Resize quick drawer" });
  fireEvent.pointerDown(separator, { clientX: 500, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 420, pointerId: 1 });
  expect(facade.calls.saveDrawerPreferences).toHaveLength(1);
  expect(screen.getByTestId("skill-quick-drawer")).toHaveAttribute("data-preset", "near_full");
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

  fireEvent.click(screen.getByRole("button", { name: "Current width: Wide. Next: Near full screen" }));
  fireEvent.click(screen.getByRole("button", { name: "Current width: Near full screen. Next: Standard width" }));
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
      "standard",
    );
  });
});

it("keeps temporary preferences visible when persistence fails", async () => {
  const facade = createMockSkillLibraryFacade({ failDrawerSave: true });
  await renderDrawer({ facade });
  fireEvent.click(await screen.findByRole("button", { name: "Current width: Wide. Next: Near full screen" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Preference was not saved",
  );
  expect(screen.getByTestId("skill-quick-drawer")).toHaveAttribute(
    "data-preset",
    "near_full",
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

it("links available updates to the version review in full details", async () => {
  await renderDrawer({ detailSearch: "?text=pdf", facade: createMockSkillLibraryFacade() });

  const updateLink = await screen.findByRole("link", { name: "View update" });
  expect(updateLink).toHaveAttribute("href", "/library/skill-pdf?text=pdf#versions");
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

  // Agent 呈现统一为「logo + 展示类型」：紧凑芯片不再渲染品牌文本，
  // 名称经 title/aria-label 提供（AGENTS.md 呈现约定）。
  const codex = await screen.findByTitle("OpenAI Codex");
  expect(codex).toBeVisible();
  expect(codex).toHaveAttribute("data-agent-id", "codex");
  expect(screen.getByTitle("Claude Code")).toHaveAttribute("data-agent-id", "claude");
  expect(screen.getByText("Document workflows")).toBeVisible();
  expect(screen.getByText("C:\\workspace\\docs")).toBeVisible();
  expect(screen.getByText("Operations")).toBeVisible();
  expect(screen.getByText("C:\\workspace\\ops")).toBeVisible();
});

it("bounds relation columns as fixed-height scroll regions", async () => {
  const facade = createMockSkillLibraryFacade({
    quickView: {
      ...QUICK_VIEW,
      agentDeployments: [
        { id: "codex", name: "OpenAI Codex" },
        { id: "claude", name: "Claude Code" },
      ],
      projectDeploymentCount: 5,
      projectDeployments: Array.from({ length: 5 }, (_, index) => ({
        id: `project-${index + 1}`,
        name: `Project ${index + 1}`,
        path: `C:\\workspace\\project-${index + 1}`,
      })),
    } as SkillQuickView,
  });
  await renderDrawer({ facade });

  // 界面规范§5批注12：Agent/项目内容区定高各自滚动，隐藏滚动条；
  // 完整列表在滚动区域内键盘可达，不再用展开/收起按钮。
  const agentRegion = await screen.findByRole("region", { name: "Added to Agents: 2" });
  expect(agentRegion).toHaveAttribute("tabindex", "0");
  const projectRegion = screen.getByRole("region", { name: "Added to projects: 5" });
  expect(projectRegion).toHaveAttribute("tabindex", "0");
  expect(within(projectRegion).getByText("Project 5")).toBeVisible();
  expect(within(projectRegion).getByText("C:\\workspace\\project-5")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Show .+ more projects|Show fewer projects/ }),
  ).not.toBeInTheDocument();
});

it("keeps the compact header, keyboard-scrollable content, and full-details route", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });
  const drawer = await screen.findByRole("dialog", { name: "PDF Reader" });
  expect(drawer.querySelector(".sh-drawer__header")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Configure quick drawer" })).not.toBeInTheDocument();
  expect(getComputedStyle(screen.getByTestId("drawer-modules-scroll")).overflowY).toBe(
    "auto",
  );
  expect(screen.getByRole("link", { name: "View full details" })).toHaveAttribute(
    "href",
    "/library/skill-pdf",
  );
  expect(document.querySelector(".sh-skill-drawer__toolbar a")).toBe(
    screen.getByRole("link", { name: "View full details" }),
  );
  expect(screen.getByRole("link", { name: "View full details" })).toHaveClass(
    "sh-button--primary",
  );
  expect(screen.queryByRole("link", { name: "Open security checks" })).not.toBeInTheDocument();
  const toolbar = document.querySelector(".sh-skill-drawer__toolbar");
  expect(toolbar?.firstElementChild).toContainElement(
    screen.getByRole("link", { name: "View full details" }),
  );
  expect(toolbar?.lastElementChild).toContainElement(
    screen.getByRole("button", { name: "Close" }),
  );
  const widthCycle = screen.getByRole("button", { name: "Current width: Wide. Next: Near full screen" });
  expect(widthCycle).toHaveClass("sh-skill-drawer__preset-cycle");
  expect(toolbar?.lastElementChild).toContainElement(widthCycle);
  const chrome = drawer.querySelector<HTMLElement>(".sh-skill-drawer__chrome");
  const titleRow = drawer.querySelector<HTMLElement>(".sh-skill-drawer__title-row");
  expect(titleRow).toContainElement(within(titleRow!).getByRole("heading", { name: "PDF Reader" }));
  expect(titleRow).toContainElement(screen.getByRole("button", { name: "Dispatch PDF Reader" }));
  expect(titleRow).toContainElement(screen.getByRole("button", { name: "Export PDF Reader" }));
  expect(chrome).toContainElement(titleRow);
});

it("sets, adjusts, and converts the trial review date through the real trial contract", async () => {
  const setTrial = vi.fn(async (_skillId: string, _due: string | null) => undefined);
  const facade = createMockSkillLibraryFacade({
    quickView: { ...QUICK_VIEW, lifecycle: "trial", trialDue: "2026-10-10" } as SkillQuickView,
  });
  await renderDrawer({ facade, trialFacade: { setTrial } });

  expect(await screen.findByText(/2026-10-10/)).toBeVisible();
  const user = userEvent2.setup();
  const adjust = screen.getByRole("button", { name: "Adjust review date" });
  await user.click(adjust);
  const dialog = await screen.findByRole("dialog", { name: "Trial review date" });
  const date = within(dialog).getByLabelText("Review date");
  fireEvent.change(date, { target: { value: "2026-11-05" } });
  await user.click(within(dialog).getByRole("button", { name: "Save review date" }));
  await waitFor(() => expect(setTrial).toHaveBeenLastCalledWith("skill-pdf", "2026-11-05"));
  expect(await screen.findByText("2026-11-05", { selector: ".sh-skill-drawer__trial-date" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Make regular" }));
  await waitFor(() => expect(setTrial).toHaveBeenLastCalledWith("skill-pdf", null));
  expect(screen.getByText("Regular")).toBeVisible();
  expect(screen.queryByRole("button", { name: /abandon trial/i })).not.toBeInTheDocument();
});

it("adds the current Skill to a combination through the existing membership contract", async () => {
  const facade = createMockSkillLibraryFacade();
  facade.listCombinations = vi.fn(async () => [
    { name: "Writing tools", members: ["skill-existing"] },
    { name: "Research kit", members: ["skill-other"] },
  ]);
  facade.updateCombination = vi.fn(async () => undefined);
  await renderDrawer({ facade });

  const add = await screen.findByRole("button", { name: "Add to combination" });
  await userEvent2.setup().click(add);
  const dialog = await screen.findByRole("dialog", { name: "Add PDF Reader to a combination" });
  await userEvent2.setup().click(within(dialog).getByRole("button", { name: "Add to Research kit" }));

  await waitFor(() => expect(facade.updateCombination).toHaveBeenCalledWith("Research kit", ["skill-other", "skill-pdf"]));
  await waitFor(() => expect(facade.listCombinations).toHaveBeenCalledTimes(2));
});

it("carries the library query and return position into full details", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({
    detailSearch: "?q=pdf&sort=version%3Adesc",
    facade,
    libraryReturn: { focusSkillId: "skill-pdf", scrollLeft: 24, scrollTop: 416 },
  });
  expect(await screen.findByRole("link", { name: "View full details" })).toHaveAttribute(
    "href",
    "/library/skill-pdf?q=pdf&sort=version%3Adesc",
  );
});

it("keeps preview full-detail links inside the development preview routes", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade, initialEntry: "/__preview/skill-library" });

  expect(await screen.findByRole("link", { name: "View full details" })).toHaveAttribute(
    "href",
    "/__preview/skill-detail/skill-pdf",
  );
});

it("inherits reduced motion while using only wired single-skill actions", async () => {
  mockReducedMotion(true);
  const facade = createMockSkillLibraryFacade({ usageEvidence: undefined });
  await renderDrawer({ facade });
  expect(await screen.findByTestId("drawer-panel")).toHaveAttribute(
    "data-reduced-motion",
    "true",
  );
  expect(screen.getByRole("button", { name: "Dispatch PDF Reader" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Export PDF Reader" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Recheck" })).toBeVisible();
  expect(screen.getByRole("button", { name: "AI check" })).toBeVisible();
  expect(facade.calls.emitBatchIntent).toHaveLength(0);
  expect(screen.getByRole("heading", { name: "Usage evidence" })).toBeVisible();
  expect(screen.queryByText(/0 invocations/i)).not.toBeInTheDocument();
});

it("offers single-skill tag actions and saves alias and note edits on blur", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });

  // 标签字段如实展示当前标签，并提供添加/移除入口。
  expect(await screen.findByText("documents")).toBeVisible();
  expect(screen.getByRole("button", { name: "Add tags" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Remove tag documents" })).toBeVisible();

  // 添加标签：读取现有标签后经 set_metadata 整体覆盖保存，不再走生产未绑定的批量通道。
  fireEvent.click(screen.getByRole("button", { name: "Add tags" }));
  const dialog = await screen.findByRole("dialog", { name: "Add tags" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Tags" }), {
    target: { value: "review, urgent" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add tags" }));
  await waitFor(() => {
    expect(facade.calls.saveSkillMetadata).toContainEqual({
      skillId: "skill-pdf",
      patch: { tags: ["documents", "pdf", "review", "urgent"] },
    });
    // 保存成功后快速视图与技能库列表查询都被失效并重新读取。
    expect(facade.calls.getSkillQuickView).toHaveLength(2);
  });
  expect(facade.calls.emitBatchIntent).not.toContainEqual(
    expect.objectContaining({ action: "add_tag" }),
  );

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

it("removes a tag chip and persists the reduced tag set", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });

  fireEvent.click(await screen.findByRole("button", { name: "Remove tag documents" }));

  await waitFor(() => {
    expect(facade.calls.saveSkillMetadata).toContainEqual({
      skillId: "skill-pdf",
      patch: { tags: ["pdf"] },
    });
    expect(facade.calls.getSkillQuickView).toHaveLength(2);
  });
  expect(facade.calls.emitBatchIntent).not.toContainEqual(
    expect.objectContaining({ action: "remove_tag" }),
  );
});

it("caps visible tags and exposes overflow through the bounded popover", async () => {
  const facade = createMockSkillLibraryFacade({
    quickView: {
      ...QUICK_VIEW,
      tags: ["documents", "pdf", "review", "urgent", "windows", "r&d templates"],
    },
  });
  await renderDrawer({ facade });

  // 标签超过可见上限时只保留上限数量的标签块，且每块携带完整值的悬浮说明。
  await screen.findByText("documents");
  const tagList = document.querySelector(".sh-skill-drawer__tag-list");
  expect(tagList?.querySelectorAll(".sh-skill-drawer__tag")).toHaveLength(4);
  expect(screen.getByTitle("urgent")).toBeInTheDocument();
  expect(screen.queryByText("r&d templates")).not.toBeInTheDocument();

  // 溢出数量用独立 +N 入口收纳，不撑高基本信息。
  const moreButton = screen.getByRole("button", { name: "2 more tags" });
  expect(moreButton).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(moreButton);
  const panel = await screen.findByRole("dialog", { name: "All tags" });
  expect(moreButton).toHaveAttribute("aria-expanded", "true");
  expect(within(panel).getByTitle("r&d templates")).toBeInTheDocument();

  // 浮层内完整标签与移除入口可达；移除后计数与浮层内容同步更新且浮层保持打开。
  expect(within(panel).getAllByRole("button", { name: /^Remove tag/ })).toHaveLength(6);
  fireEvent.click(within(panel).getByRole("button", { name: "Remove tag windows" }));
  expect(within(panel).getAllByRole("button", { name: /^Remove tag/ })).toHaveLength(5);
  expect(screen.getByRole("button", { name: "1 more tag" })).toBeVisible();

  // 关闭浮层后焦点返回触发按钮。
  fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "All tags" })).not.toBeInTheDocument();
  });
  expect(moreButton).toHaveFocus();
});

it("keeps every tag inline when they fit the visible cap", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });

  await screen.findByText("documents");
  expect(screen.queryByRole("button", { name: /more tag/ })).not.toBeInTheDocument();
});

it("refreshes the bootstrap snapshot after drawer metadata changes", async () => {
  const refreshSnapshot = vi.fn(async () => undefined);
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade, refreshSnapshot });

  fireEvent.click(await screen.findByRole("button", { name: "Remove tag documents" }));

  await waitFor(() => {
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });
});

it("shows a visible failure and restores the saved tags when a tag save is rejected", async () => {
  const facade = createMockSkillLibraryFacade({
    saveSkillMetadata: async () => {
      throw new Error("tag write failed");
    },
  });
  await renderDrawer({ facade });

  fireEvent.click(await screen.findByRole("button", { name: "Remove tag documents" }));

  const drawer = await screen.findByTestId("skill-quick-drawer");
  await waitFor(() => {
    expect(within(drawer).getByRole("alert")).toHaveTextContent(
      /tags were not saved/i,
    );
  });
  // 乐观更新被回滚：被移除的标签仍然可见且可再次操作。
  expect(
    within(drawer).getByRole("button", { name: "Remove tag documents" }),
  ).toBeVisible();
});

it("reports a failure instead of silently dropping tag edits when the facade cannot save metadata", async () => {
  const facade = createMockSkillLibraryFacade();
  delete (facade as { saveSkillMetadata?: unknown }).saveSkillMetadata;
  await renderDrawer({ facade });

  fireEvent.click(await screen.findByRole("button", { name: "Remove tag documents" }));

  const drawer = await screen.findByTestId("skill-quick-drawer");
  await waitFor(() => {
    expect(within(drawer).getByRole("alert")).toHaveTextContent(
      /tags were not saved/i,
    );
  });
});

it("shows the runtime name beside the aliased display name in the identity region", async () => {
  const facade = createMockSkillLibraryFacade({
    quickView: { ...QUICK_VIEW, alias: "PDF Reader", originalName: "pdf-reader" },
  });
  await renderDrawer({ facade });

  const drawer = await screen.findByTestId("skill-quick-drawer");
  const identity = drawer.querySelector(".sh-skill-drawer__identity");
  if (!identity) throw new Error("Expected the drawer identity region");
  expect(within(identity as HTMLElement).getByText("Original name:")).toBeVisible();
  expect(within(identity as HTMLElement).getByText("pdf-reader")).toBeVisible();
});

it("keeps the runtime original name after saving a new alias (alias never renames)", async () => {
  // M-21 双证据（前端组件侧）：别名编辑只更新别名，原名展示保持不变；
  // runtime 原名不被改写的后端契约由 skillhub-core catalog_rules 覆盖。
  const facade = createMockSkillLibraryFacade({
    quickView: { ...QUICK_VIEW, alias: "PDF Reader", originalName: "pdf-reader" },
  });
  await renderDrawer({ facade });

  fireEvent.click(await screen.findByRole("button", { name: "Edit alias" }));
  const aliasInput = screen.getByRole("textbox", { name: "Alias" });
  fireEvent.change(aliasInput, { target: { value: "PDF 阅读助手" } });
  fireEvent.blur(aliasInput);

  await waitFor(() => {
    expect(facade.calls.saveSkillMetadata).toContainEqual({
      skillId: "skill-pdf",
      patch: { alias: "PDF 阅读助手" },
    });
  });
  const drawer = screen.getByTestId("skill-quick-drawer");
  const identity = drawer.querySelector(".sh-skill-drawer__identity");
  if (!identity) throw new Error("Expected the drawer identity region");
  // 别名已更新，原名（runtime_name）在抽屉身份区保持可见且未被改写。
  expect(within(identity as HTMLElement).getByText("Original name:")).toBeVisible();
  expect(within(identity as HTMLElement).getByText("pdf-reader")).toBeVisible();
  expect(within(identity as HTMLElement).getByText("PDF 阅读助手")).toBeVisible();
});

it("edits my purpose in the drawer and saves it as independent metadata", async () => {
  // M-21 #6：“我的用途”在抽屉内获得编辑入口（与别名/备注同一编辑形态）。
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });

  expect(await screen.findByText("Read and extract PDFs")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Edit purpose" }));
  const purposeInput = screen.getByRole("textbox", { name: "My purpose" });
  fireEvent.change(purposeInput, { target: { value: "用于合同扫描件归档" } });
  fireEvent.blur(purposeInput);

  await waitFor(() => {
    expect(facade.calls.saveSkillMetadata).toContainEqual({
      skillId: "skill-pdf",
      patch: { purpose: "用于合同扫描件归档" },
    });
  });
  expect(screen.getByText("用于合同扫描件归档")).toBeVisible();
});

it("translates the original description and only writes the result to purpose after confirmation", async () => {
  const facade = createMockSkillLibraryFacade();
  facade.translateDescription = vi.fn().mockResolvedValue({ text: "用于读取 PDF 文本" });
  await renderDrawer({ facade });

  fireEvent.click(await screen.findByRole("button", { name: "Translate description" }));
  expect(await screen.findByText("用于读取 PDF 文本")).toBeVisible();
  expect(facade.calls.saveSkillMetadata).toEqual([]);

  fireEvent.click(screen.getByRole("button", { name: "Use as my purpose" }));
  await waitFor(() => {
    expect(facade.calls.saveSkillMetadata).toContainEqual({
      skillId: "skill-pdf",
      patch: { purpose: "用于读取 PDF 文本" },
    });
  });
});

it("keeps long summary text intact in the drawer's single body scroll area", async () => {
  const originalDescription = "很长的原始描述内容。".repeat(120);
  const translatedDescription = "A very long translated description.".repeat(120);
  const purpose = "A long user purpose that remains available in the drawer. ".repeat(40);
  const facade = createMockSkillLibraryFacade({
    quickView: {
      ...QUICK_VIEW,
      originalDescription,
      translatedDescription,
      purpose,
    },
  });
  await renderDrawer({ facade });

  const drawer = await screen.findByTestId("skill-quick-drawer");
  const body = drawer.querySelector("[data-testid='drawer-modules-scroll']");
  expect(body).toBeInTheDocument();
  expect(body).toContainElement(drawer.querySelector(".sh-skill-drawer__overview"));
  expect(drawer.querySelectorAll(".sh-skill-drawer__field-value--clamped")).toHaveLength(0);
  expect(drawer.querySelector(".sh-skill-drawer__description-block .sh-skill-drawer__field-value"))
    .toHaveTextContent(originalDescription);
  expect(Array.from(drawer.querySelectorAll(".sh-skill-drawer__field-value"))
    .find((field) => field.textContent?.includes(translatedDescription)))
    .toHaveTextContent(translatedDescription);
  expect(drawer.querySelector(".sh-skill-drawer__purpose-row .sh-skill-drawer__field-value")?.textContent)
    .toBe(purpose);
});

it("labels drawer identity fields in source-first and user-metadata order", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });

  const drawer = await screen.findByTestId("skill-quick-drawer");
  const identity = within(drawer).getByRole("heading", { name: "PDF Reader" });
  const region = drawer.querySelector(".sh-skill-drawer__identity");
  expect(region).toBeInTheDocument();
  expect(drawer.querySelector(".sh-skill-drawer__chrome")).toContainElement(identity);
  expect(region).not.toContainElement(identity);

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

it("refetches the persisted quick view and library list after a metadata save succeeds", async () => {
  const quickView: SkillQuickView = { ...QUICK_VIEW, alias: "reader" };
  const facade = createMockSkillLibraryFacade({
    quickView,
    saveSkillMetadata: async () => {
      // 保存成功后持久层已有新值，模拟失效触发的重新读取读到已保存内容。
      quickView.alias = "PDF helper";
    },
  });
  await renderDrawer({ facade });

  fireEvent.click(await screen.findByRole("button", { name: "Edit alias" }));
  const aliasInput = screen.getByRole("textbox", { name: "Alias" });
  fireEvent.change(aliasInput, { target: { value: "PDF helper" } });
  fireEvent.blur(aliasInput);

  await waitFor(() => {
    expect(facade.calls.saveSkillMetadata).toContainEqual({
      skillId: "skill-pdf",
      patch: { alias: "PDF helper" },
    });
    // 保存成功后快速视图与技能库列表查询都被失效并重新读取。
    expect(facade.calls.getSkillQuickView).toHaveLength(2);
    expect(facade.calls.listSkills).toBe(2);
  });
  expect(screen.getByText("PDF helper")).toBeVisible();
});

it("shows a save failure and restores the persisted value when saving metadata fails", async () => {
  const facade = createMockSkillLibraryFacade({
    saveSkillMetadata: async () => {
      throw new Error("metadata write failed");
    },
  });
  await renderDrawer({ facade });

  fireEvent.click(await screen.findByRole("button", { name: "Edit alias" }));
  const aliasInput = screen.getByRole("textbox", { name: "Alias" });
  fireEvent.change(aliasInput, { target: { value: "Broken save" } });
  fireEvent.blur(aliasInput);

  const drawer = await screen.findByTestId("skill-quick-drawer");
  await waitFor(() => {
    expect(within(drawer).getByRole("alert")).toHaveTextContent(/was not saved/i);
  });
  // 乐观更新被回滚，界面回到已持久化的别名。
  expect(within(drawer).getByText("reader")).toBeVisible();
  expect(within(drawer).queryByText("Broken save")).not.toBeInTheDocument();
});

it("reports a failure instead of silently dropping edits when the facade cannot save metadata", async () => {
  const facade = createMockSkillLibraryFacade();
  delete (facade as { saveSkillMetadata?: unknown }).saveSkillMetadata;
  await renderDrawer({ facade });

  fireEvent.click(await screen.findByRole("button", { name: "Edit alias" }));
  const aliasInput = screen.getByRole("textbox", { name: "Alias" });
  fireEvent.change(aliasInput, { target: { value: "Unsaved alias" } });
  fireEvent.blur(aliasInput);

  const drawer = await screen.findByTestId("skill-quick-drawer");
  await waitFor(() => {
    expect(within(drawer).getByRole("alert")).toHaveTextContent(/was not saved/i);
  });
  expect(within(drawer).getByText("reader")).toBeVisible();
  expect(within(drawer).queryByText("Unsaved alias")).not.toBeInTheDocument();
});

it("uses keyboard-labelled pencil controls for metadata edits", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });

  const editAlias = await screen.findByRole("button", { name: "Edit alias" });
  expect(editAlias).toHaveTextContent(/^\s*$/);
  expect(editAlias).toHaveAttribute("data-tooltip", "Edit alias");
  expect(editAlias.querySelector("svg[aria-hidden='true']")).not.toBeNull();

  const editNote = screen.getByRole("button", { name: "Edit note" });
  expect(editNote).toHaveTextContent(/^\s*$/);
  expect(editNote).toHaveAttribute("data-tooltip", "Edit note");
  expect(editNote.querySelector("svg[aria-hidden='true']")).not.toBeNull();

  const editPurpose = screen.getByRole("button", { name: "Edit purpose" });
  expect(editPurpose).toHaveAttribute("data-tooltip", "Edit purpose");
  const addTags = screen.getByRole("button", { name: "Add tags" });
  expect(addTags).toHaveAttribute("data-tooltip", "Add tags");
});

it("runs security checks and shows findings directly in the drawer", async () => {
  const fixture = separateCheckFixture();
  const runBasicCheck = vi.fn(async () => undefined);
  const securityFacade: SecurityFacade = {
    getChecks: async () => fixture.checks,
    listFindings: async () => fixture.findings,
    setFindingDisposition: async () => undefined,
    getPreferences: async () => ({ llmProvider: "local-model", dataScope: "explicit_selection" }),
    runBasicCheck,
    runLlmCheck: async () => undefined,
  };
  await renderDrawer({ facade: createMockSkillLibraryFacade(), securityFacade });

  expect(await screen.findByRole("button", { name: "Recheck" })).toBeVisible();
  expect(screen.getByRole("button", { name: "AI check" })).toBeVisible();
  fireEvent.click(screen.getByText("Review 1 findings"));
  expect(screen.getByText("发现疑似凭据字符串，请先确认来源。")).toBeVisible();
  expect(screen.queryByRole("link", { name: "Open security checks" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
  await waitFor(() => expect(runBasicCheck).toHaveBeenCalledWith("skill-pdf", "current"));
});

it("closes with the shared close icon instead of a character glyph", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });

  const close = await screen.findByRole("button", { name: "Close" });
  expect(close).not.toHaveTextContent("×");
  expect(close.querySelector("svg")).not.toBeNull();
});

it("keeps the skill name and primary actions in one compact header with a single width cycle", async () => {
  await renderDrawer({
    facade: createMockSkillLibraryFacade(),
    onDelete: vi.fn(),
  });

  const drawer = await screen.findByTestId("skill-quick-drawer");
  const chrome = drawer.querySelector<HTMLElement>(".sh-skill-drawer__chrome");
  const title = within(drawer).getByRole("heading", { name: "PDF Reader" });
  const dispatch = within(drawer).getByRole("button", { name: "Dispatch PDF Reader" });
  const exportSkill = within(drawer).getByRole("button", { name: "Export PDF Reader" });
  const deleteSkill = within(drawer).getByRole("button", { name: "Delete from library" });

  expect(chrome).toContainElement(title);
  expect(chrome).toContainElement(dispatch);
  expect(chrome).toContainElement(exportSkill);
  expect(chrome).toContainElement(deleteSkill);
  expect(dispatch.compareDocumentPosition(exportSkill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(exportSkill.compareDocumentPosition(deleteSkill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(drawer).queryByRole("button", { name: "Configure quick drawer" })).not.toBeInTheDocument();
  expect(within(drawer).queryByRole("group", { name: "Quick drawer width" })).not.toBeInTheDocument();
  expect(within(drawer).getByRole("button", { name: "Current width: Wide. Next: Near full screen" })).toBeVisible();
});

it("keeps core drawer content visible when stored layout preferences hide or reorder modules", async () => {
  await renderDrawer({
    facade: createMockSkillLibraryFacade(),
    preferences: {
      ...DEFAULT_DRAWER_PREFERENCES,
      moduleOrder: [...DEFAULT_DRAWER_PREFERENCES.moduleOrder].reverse(),
      visibleModules: [],
    },
  });

  const drawer = await screen.findByTestId("skill-quick-drawer");
  expect(within(drawer).getByText("Read and extract PDFs")).toBeVisible();
  expect(within(drawer).getByRole("heading", { name: "Security checks" })).toBeVisible();
  expect(within(drawer).getByRole("heading", { name: "Relations" })).toBeVisible();
  expect(within(drawer).getByRole("heading", { name: "Source and license" })).toBeVisible();
  expect(within(drawer).getByRole("heading", { name: "Versions" })).toBeVisible();

  const moduleHeadings = [...drawer.querySelectorAll(".sh-skill-drawer__module h3")]
    .map((heading) => heading.textContent?.trim());
  expect(moduleHeadings.indexOf("Security checks")).toBeLessThan(moduleHeadings.indexOf("Relations"));
  expect(moduleHeadings.indexOf("Relations")).toBeLessThan(moduleHeadings.indexOf("Source and license"));
  expect(moduleHeadings.indexOf("Source and license")).toBeLessThan(moduleHeadings.indexOf("Versions"));
});


describe("drawer primary actions equivalence", () => {
  it("keeps dispatch, export, and delete in the fixed title row without duplicate update actions", async () => {
    await renderDrawer({ facade: createMockSkillLibraryFacade(), onDelete: vi.fn() });

    expect(await screen.findByRole("button", { name: "Dispatch PDF Reader" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export PDF Reader" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete from library" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Check source updates" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "View update" })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "View versions" })).not.toBeInTheDocument();
  });

  it("navigates add-to and export entries with the single-skill contract", async () => {
    const locations: Array<string> = [];
    function LocationProbe() {
      const location = useLocation();
      locations.push(`${location.pathname}${location.search}#${JSON.stringify(location.state)}`);
      return null;
    }
    // 复用 DrawerHarness 渲染，但追加一个路由探针。
    const i18n = await createSkillHubI18n(["en-US"]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
      const [controlledPreferences, setControlledPreferences] = useState(() => clonePreferences(DEFAULT_DRAWER_PREFERENCES));
      const returnFocusRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <LocationProbe />
          <button ref={returnFocusRef} type="button">PDF Reader row</button>
          <SkillQuickDrawer
            facade={createMockSkillLibraryFacade()}
            securityFacade={createPreviewSecurityFacade()}
            onDelete={vi.fn()}
            onOpenChange={() => undefined}
            onPreferencesChange={setControlledPreferences}
            open
            preferences={controlledPreferences}
            returnFocusRef={returnFocusRef}
            skillId="skill-pdf"
          />
        </>
      );
    }
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={["/library"]}>
            <Harness />
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    );

    const user = userEvent2.setup();
    await user.click(await screen.findByRole("button", { name: "Dispatch PDF Reader" }));
    expect(locations.at(-1)).toContain("/deploy?skill=skill-pdf");

    await user.click(screen.getByRole("button", { name: "Export PDF Reader" }));
    expect(locations.at(-1)).toContain("/settings/data-protection");
    expect(locations.at(-1)).toContain(JSON.stringify({ exportSkillIds: ["skill-pdf"] }));
  });
});

it("keeps the overview in the scroll region and core actions in the fixed title row", async () => {
  await renderDrawer({
    facade: createMockSkillLibraryFacade(),
    onDelete: vi.fn(),
  });

  const drawer = await screen.findByTestId("skill-quick-drawer");
  const title = within(drawer).getByRole("heading", { name: "PDF Reader" });
  const chrome = drawer.querySelector<HTMLElement>(".sh-skill-drawer__chrome");
  const overview = drawer.querySelector<HTMLElement>(".sh-skill-drawer__overview");
  const body = drawer.querySelector<HTMLElement>("[data-testid='drawer-modules-scroll']");
  expect(overview).not.toBeNull();
  expect(chrome).toContainElement(title);
  expect(body).not.toContainElement(title);
  expect(body).toContainElement(overview);
  expect(overview).toContainElement(within(drawer).getByText("Extracts text from PDF files."));
  expect(overview).toContainElement(within(drawer).getByText("Read and extract PDFs"));
  expect(overview?.querySelector(".sh-skill-drawer__summary-grid")).not.toBeNull();
  expect(overview?.querySelector(".sh-skill-drawer__summary-item--lifecycle")).toHaveTextContent("LifecycleRegular");
  expect(overview?.querySelector(".sh-skill-drawer__summary-item--version")).toHaveTextContent("Version1.4.0");
  expect(overview?.querySelector(".sh-skill-drawer__summary-item--agents")).toHaveTextContent("Agent destinations2");
  expect(overview?.querySelector(".sh-skill-drawer__summary-item--projects")).toHaveTextContent("Project destinations3");

  const actions = drawer.querySelector<HTMLElement>(".sh-skill-drawer__header-actions");
  expect(actions).toContainElement(within(drawer).getByRole("button", { name: "Dispatch PDF Reader" }));
  expect(chrome).toContainElement(actions);
  expect(body).not.toContainElement(actions);
  expect(body).toContainElement(drawer.querySelector<HTMLElement>(".sh-skill-drawer__risk"));
  const modules = drawer.querySelector(".sh-skill-drawer__modules");
  expect(modules).not.toBeNull();
  expect(overview!.compareDocumentPosition(modules as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("does not show a delete action without a delete handler", async () => {
  await renderDrawer({
    facade: createMockSkillLibraryFacade(),
  });

  await screen.findByTestId("skill-quick-drawer");
  expect(screen.queryByRole("button", { name: "Delete from library" })).not.toBeInTheDocument();
});
