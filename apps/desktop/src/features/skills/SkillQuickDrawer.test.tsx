import userEvent2 from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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

const QUICK_VIEW: SkillQuickView = {
  aiCheck: "unavailable",
  agentDeploymentCount: 2,
  alias: "reader",
  basicCheck: "passed",
  currentVersion: "1.4.0",
  currentVersionId: "fixture-version-1",
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
  libraryReturn?: { focusSkillId: string; scrollLeft: number; scrollTop: number };
  onLocationChange?: (location: ReturnType<typeof useLocation>) => void;
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
  onLocationChange,
  open = true,
  preferences = DEFAULT_DRAWER_PREFERENCES,
  refreshSnapshot,
  securityFacade,
  skillId = "skill-pdf",
}: DrawerHarnessProps) {
  const [controlledPreferences, setControlledPreferences] = useState(() =>
    clonePreferences(preferences),
  );
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  useEffect(() => {
    onLocationChange?.(location);
  }, [location, onLocationChange]);
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
  fireEvent.click(screen.getByRole("button", { name: "Current: Wide; click to switch to Near full screen" }));
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

  fireEvent.click(screen.getByRole("button", { name: "Current: Wide; click to switch to Near full screen" }));
  fireEvent.click(screen.getByRole("button", { name: "Current: Near full screen; click to switch to Standard width" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "Current: Wide; click to switch to Near full screen" }));
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

it("shows prototype agent cards and project relation targets with paths", async () => {
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

  // 原型关系卡：已知客户端展示名收敛为品牌呈现，项目卡带路径。
  expect(await screen.findByTitle("Codex CLI")).toBeVisible();
  expect(screen.getByTitle("Claude Code")).toBeVisible();
  expect(screen.getByText("Document workflows")).toBeVisible();
  expect(screen.getByText("C:\\workspace\\docs")).toBeVisible();
  expect(screen.getByText("Operations")).toBeVisible();
  expect(screen.getByText("C:\\workspace\\ops")).toBeVisible();
});

it("bounds prototype relation columns as fixed-height scroll regions", async () => {
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

  // 界面规范§5批注12：Agent/项目内容区定高各自滚动，完整列表在滚动区域内
  // 键盘可达；原型不再提供展开/收起按钮。
  const agentRegion = await screen.findByRole("region", { name: "Added to Agents: 2" });
  expect(agentRegion).toHaveAttribute("tabindex", "0");
  const projectRegion = screen.getByRole("region", { name: "Project relation targets, 5 total" });
  expect(projectRegion).toHaveAttribute("tabindex", "0");
  expect(within(projectRegion).getByText("Project 5")).toBeVisible();
  expect(within(projectRegion).getByText("C:\\workspace\\project-5")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Show .+ more projects|Show fewer projects/ }),
  ).not.toBeInTheDocument();
});

it("keeps the prototype chrome with a single width cycle and the full-details route", async () => {
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
  expect(screen.getByRole("link", { name: "View full details" })).toHaveClass(
    "sh-skill-drawer__prototype-details",
  );
  const toolbar = document.querySelector(".sh-skill-drawer__toolbar");
  expect(toolbar?.firstElementChild).toContainElement(
    screen.getByRole("link", { name: "View full details" }),
  );
  expect(toolbar?.lastElementChild).toContainElement(
    screen.getByRole("button", { name: "Close" }),
  );
  const widthCycle = screen.getByRole("button", { name: "Current: Wide; click to switch to Near full screen" });
  expect(widthCycle).toHaveClass("sh-skill-drawer__preset-icon-button");
  expect(toolbar?.lastElementChild).toContainElement(widthCycle);
  const chrome = drawer.querySelector<HTMLElement>(".sh-skill-drawer__chrome");
  const heading = drawer.querySelector<HTMLElement>(".sh-skill-drawer__prototype-heading");
  expect(chrome).toContainElement(heading);
  expect(heading).toContainElement(within(heading!).getByRole("heading", { name: "PDF Reader" }));
  expect(heading).toContainElement(screen.getByRole("button", { name: "Dispatch" }));
  expect(heading).toContainElement(screen.getByRole("button", { name: "Export" }));
  expect(heading).toContainElement(screen.getByRole("button", { name: "Delete" }));
});

it("edits collections through the bounded popover without touching combination contracts", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });

  expect(await screen.findByText("文档工具")).toBeVisible();
  expect(screen.getByText("PDF 工作流")).toBeVisible();
  expect(screen.queryByText("研发工具")).not.toBeInTheDocument();

  const user = userEvent2.setup();
  await user.click(screen.getByRole("button", { name: "Edit collections" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit collections" });
  await user.click(within(dialog).getByRole("checkbox", { name: "研发工具" }));
  await user.click(within(dialog).getByRole("button", { name: "Save collection preview" }));

  // 集合模块是原型预览：仅更新本地展示状态，不调用组合契约。
  expect(screen.getByText("研发工具")).toBeVisible();
  expect(facade.calls.emitBatchIntent).toHaveLength(0);
  expect(facade.calls.saveSkillMetadata).toHaveLength(0);
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

it("inherits reduced motion while action entries stay display-only", async () => {
  mockReducedMotion(true);
  const facade = createMockSkillLibraryFacade({ usageEvidence: undefined });
  await renderDrawer({ facade });
  expect(await screen.findByTestId("drawer-panel")).toHaveAttribute(
    "data-reduced-motion",
    "true",
  );
  for (const name of ["Dispatch", "Export", "Delete", "Recheck", "AI check"]) {
    expect(screen.getByRole("button", { name })).toBeVisible();
  }
  expect(document.querySelectorAll("[data-prototype-action='true']").length).toBeGreaterThan(0);
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
  const tagList = document.querySelector(".sh-skill-drawer__prototype-tag-list");
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
  expect(screen.getByRole("button", { name: "1 more tags" })).toBeVisible();

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

  fireEvent.click(await screen.findByRole("button", { name: "AI translation" }));
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
  const heading = within(drawer).getByRole("heading", { name: "PDF Reader" });
  const region = drawer.querySelector(".sh-skill-drawer__identity");
  expect(region).toBeInTheDocument();
  expect(drawer.querySelector(".sh-skill-drawer__chrome")).toContainElement(heading);
  expect(region).not.toContainElement(heading);

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
  // 第一条发现直接展示在模块内；完整清单经折叠面板可达（发现标题在模块与
  // 默认展开的清单中各出现一次）。
  expect((await screen.findAllByText("发现疑似凭据字符串，请先确认来源。")).length).toBeGreaterThan(0);
  expect(screen.getByText("View all findings (1)")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
  await waitFor(() => expect(runBasicCheck).toHaveBeenCalledWith("skill-pdf", "fixture-version-1"));
});

it("uses the exact fixture version for security checks", async () => {
  const getChecks = vi.fn(async () => separateCheckFixture().checks);
  const listFindings = vi.fn(async () => separateCheckFixture().findings);
  const runBasicCheck = vi.fn(async () => undefined);
  const securityFacade: SecurityFacade = {
    ...createPreviewSecurityFacade(),
    getChecks,
    listFindings,
    runBasicCheck,
  };

  await renderDrawer({ facade: createMockSkillLibraryFacade(), securityFacade });

  await waitFor(() => expect(getChecks).toHaveBeenCalledWith("skill-pdf", "fixture-version-1"));
  expect(listFindings).toHaveBeenCalledWith("skill-pdf", "fixture-version-1");
  fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
  await waitFor(() => expect(runBasicCheck).toHaveBeenCalledWith("skill-pdf", "fixture-version-1"));
});

it("keeps security checks unavailable when the fixture has no version identity", async () => {
  const facade = createMockSkillLibraryFacade({
    quickView: { ...QUICK_VIEW, currentVersionId: undefined },
  });
  const getChecks = vi.fn(async () => separateCheckFixture().checks);
  const runBasicCheck = vi.fn(async () => undefined);
  const securityFacade: SecurityFacade = {
    ...createPreviewSecurityFacade(),
    getChecks,
    runBasicCheck,
  };

  await renderDrawer({ facade, securityFacade });

  expect(getChecks).not.toHaveBeenCalled();
  expect((await screen.findAllByText("No version is available to check.")).length).toBeGreaterThan(0);
  expect(await screen.findByRole("button", { name: "Recheck" })).toBeDisabled();
  expect(await screen.findByRole("button", { name: "AI check" })).toBeDisabled();
  expect(runBasicCheck).not.toHaveBeenCalled();
});

it("closes with the shared close icon instead of a character glyph", async () => {
  const facade = createMockSkillLibraryFacade();
  await renderDrawer({ facade });

  const close = await screen.findByRole("button", { name: "Close" });
  expect(close).not.toHaveTextContent("×");
  expect(close.querySelector("svg")).not.toBeNull();
});

it("keeps the skill name and display-only actions in one compact header with a single width cycle", async () => {
  await renderDrawer({ facade: createMockSkillLibraryFacade() });

  const drawer = await screen.findByTestId("skill-quick-drawer");
  const chrome = drawer.querySelector<HTMLElement>(".sh-skill-drawer__chrome");
  const title = within(drawer).getByRole("heading", { name: "PDF Reader" });
  const dispatch = within(drawer).getByRole("button", { name: "Dispatch" });
  const exportSkill = within(drawer).getByRole("button", { name: "Export" });
  const deleteSkill = within(drawer).getByRole("button", { name: "Delete" });

  expect(chrome).toContainElement(title);
  expect(chrome).toContainElement(dispatch);
  expect(chrome).toContainElement(exportSkill);
  expect(chrome).toContainElement(deleteSkill);
  for (const button of [dispatch, exportSkill, deleteSkill]) {
    expect(button).toHaveAttribute("data-prototype-action", "true");
  }
  expect(within(drawer).queryByRole("button", { name: "Configure quick drawer" })).not.toBeInTheDocument();
  // 原型保留单一宽度循环按钮（无档位单选组），aria group 仅包裹该按钮。
  const widthGroup = within(drawer).getByRole("group", { name: "Quick drawer width" });
  expect(within(widthGroup).getAllByRole("button")).toHaveLength(1);
  expect(within(drawer).getByRole("button", { name: "Current: Wide; click to switch to Near full screen" })).toBeVisible();
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
  expect(within(drawer).getByRole("heading", { name: "Relations" })).toBeVisible();
  expect(within(drawer).getByRole("heading", { name: "Collections" })).toBeVisible();
  expect(within(drawer).getByRole("heading", { name: "Skill body location" })).toBeVisible();
  expect(within(drawer).getByRole("heading", { name: "Security checks" })).toBeVisible();
  expect(within(drawer).getByRole("heading", { name: "Source and version" })).toBeVisible();
  // 使用证据是唯一跟随偏好的可选模块；隐藏后不渲染。
  expect(within(drawer).queryByRole("heading", { name: "Usage evidence" })).not.toBeInTheDocument();

  const moduleHeadings = [...drawer.querySelectorAll(".sh-skill-drawer__module h3")]
    .map((heading) => heading.textContent?.trim());
  expect(moduleHeadings[0]).toBe("Relations");
  expect(moduleHeadings.at(-1)).toBe("Source and version");
});

it("keeps the overview in the scroll region and display-only actions in the fixed heading", async () => {
  await renderDrawer({ facade: createMockSkillLibraryFacade() });

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
  expect(overview?.querySelector(".sh-skill-drawer__summary-item--version")).toHaveTextContent("1.4.0");
  expect(overview?.querySelector(".sh-skill-drawer__summary-item--agents")).toHaveTextContent("2");
  expect(overview?.querySelector(".sh-skill-drawer__summary-item--projects")).toHaveTextContent("3");

  const actions = drawer.querySelector<HTMLElement>(".sh-skill-drawer__prototype-actions");
  expect(actions).toContainElement(within(drawer).getByRole("button", { name: "Dispatch" }));
  expect(chrome).toContainElement(actions);
  expect(body).not.toContainElement(actions);
  const modules = drawer.querySelector(".sh-skill-drawer__modules");
  expect(modules).not.toBeNull();
  expect(overview!.compareDocumentPosition(modules as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("opens display-only action previews without navigating", async () => {
  const locations: Array<string> = [];
  let currentLocation: ReturnType<typeof useLocation> | undefined;
  await renderDrawer({
    facade: createMockSkillLibraryFacade(),
    onLocationChange: (location) => {
      currentLocation = location;
      locations.push(`${location.pathname}${location.search}`);
    },
  });

  const user = userEvent2.setup();
  await user.click(await screen.findByRole("button", { name: "Dispatch" }));
  const dialog = await screen.findByRole("dialog", { name: "Dispatch preview" });
  expect(within(dialog).getByText(
    "For review of the entry point and impact only. Nothing is actually dispatched, exported, or deleted.",
  )).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Cancel preview" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Dispatch preview" })).not.toBeInTheDocument();
  });

  await user.click(screen.getByRole("button", { name: "Delete" }));
  expect(screen.getByRole("dialog", { name: "Delete preview" })).toBeVisible();
  expect(currentLocation?.pathname).toBe("/library");
  expect(locations.every((entry) => entry === "/library")).toBe(true);
});

it("combines source and version into one final overview with update navigation", async () => {
  await renderDrawer({ facade: createMockSkillLibraryFacade() });
  const title = await screen.findByRole("heading", { name: "Source and version" });
  const module = title.closest("section")!;
  expect(within(module).getByText("1.4.0")).toBeInTheDocument();
  expect(within(module).getByRole("link", { name: "View update" })).toHaveAttribute("href", "/library/skill-pdf#versions");
  expect(screen.queryByRole("heading", { name: "Versions" })).not.toBeInTheDocument();
});
