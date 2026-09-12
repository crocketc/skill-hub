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
import { AppNotificationsProvider } from "../../ui/notifications";
import {
  SkillLibraryUnavailableError,
  type SavedSkillView,
  type SkillDrawerPreferences,
  type SkillLibraryFacade,
  type SkillPage,
} from "./api";
import { SkillLibraryPage } from "./SkillLibraryPage";
import type { RemovalFacade } from "../removal/api";
import {
  createMockSkillLibraryFacade,
  MOCK_SKILL_DOCX,
  MOCK_SKILL_PDF,
  type MockSkillLibraryFacade,
} from "./testFixtures";

interface RenderLibraryOptions {
  facade: SkillLibraryFacade;
  initialEntry?: InitialEntry;
  onOpenDiscovery?: () => void;
  queryRetry?: boolean | number;
  removalFacade?: RemovalFacade;
  /** "table" (default) simulates a persisted table preference; "unset" keeps
   * the facade without loadViewMode so the page default (cards) applies. */
  persistedViewMode?: "table" | "unset";
}

interface RenderedLibrary {
  queryClient: QueryClient;
  router: ReturnType<typeof createMemoryRouter>;
}

function renderLibrary({
  facade,
  initialEntry = "/library",
  onOpenDiscovery,
  queryRetry = false,
  removalFacade,
  persistedViewMode = "table",
}: RenderLibraryOptions): RenderedLibrary {
  // T3-B 起页面默认卡片视图；既有表格语义测试统一模拟“用户已持久化表格视图”，
  // 默认卡片行为由 persistedViewMode: "unset" 的用例覆盖。
  if (persistedViewMode === "table") {
    facade.loadViewMode ??= vi.fn(async () => "table" as const);
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: queryRetry, retryDelay: 0 } },
  });
  const router = createMemoryRouter(
    [
      { path: "/library", element: <SkillLibraryPage facade={facade} onOpenDiscovery={onOpenDiscovery} removalFacade={removalFacade} /> },
      // P1-11：卡片“查看”按钮跳完整详情页。
      { path: "/library/:skillId", element: <p>Skill detail page</p> },
      { path: "/deploy", element: <p>Batch deployment</p> },
      { path: "/settings/data-protection", element: <p>Data protection export</p> },
      { path: "/library/combinations", element: <p>Combination manager</p> },
    ],
    { initialEntries: [initialEntry] },
  );

  render(
    <I18nextProvider i18n={skillHubI18n}>
      <QueryClientProvider client={queryClient}>
        {/* M-21：页面直接消费全局通知服务，测试宿主挂同一 Provider 契约。 */}
        <AppNotificationsProvider>
          <RouterProvider router={router} />
        </AppNotificationsProvider>
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
  it("slides the batch deletion confirmation up from the bottom without moving the list (M-21)", async () => {
    const facade = createMockSkillLibraryFacade();
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        deployments: [{ id: "dep-1", label: "Codex CLI", path: "C:/codex", physicalId: "codex" }],
        dependentProjects: [], operationId: "delete-pdf", skillId: "skill-pdf", skillName: "PDF Reader",
        declaredDependencies: [], pinnedVersions: [], combinations: [], relatedSkills: [], unknownExternalReferences: [],
      }),
      commitDelete: vi.fn().mockResolvedValue({ centralSkillDeleted: true }),
    };
    renderLibrary({ facade, removalFacade });

    await screen.findByRole("table");
    // Radix 模态会把抽屉外内容标记 aria-hidden，先持有区域引用再打开抽屉。
    const region = screen.getByRole("region", { name: "Skill results" });
    region.scrollTop = 120;
    fireEvent.click(screen.getByRole("checkbox", { name: "Select PDF Reader" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected Skills from library" }));

    const dialog = await screen.findByRole("dialog", { name: "Review batch deletion impact" });
    // 底部抽屉：portal 面板带底部滑出类，不在页面文档流内（不再跳到页面底部）。
    const panel = screen.getByTestId("drawer-panel");
    expect(panel).toHaveClass("sh-skill-library__removal-drawer");
    expect(region.contains(panel)).toBe(false);
    // 打开确认不滚动、不跳转原列表。
    expect(region.scrollTop).toBe(120);

    // 确认/取消语义与既有删除影响预览一致：先处理部署关系，再两步确认。
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Deployment handling: Codex CLI" }),
      { target: { value: "keep_deployed" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue to force deletion" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Click again to confirm deleting 1 Skills" }),
    );
    await waitFor(() =>
      expect(removalFacade.commitDelete).toHaveBeenCalledWith("delete-pdf", {
        "dep-1": "keep_deployed",
      }),
    );
  });

  it("keeps the list selection when the batch confirmation drawer is cancelled", async () => {
    const facade = createMockSkillLibraryFacade();
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        deployments: [], dependentProjects: [], operationId: "delete-pdf", skillId: "skill-pdf", skillName: "PDF Reader",
        declaredDependencies: [], pinnedVersions: [], combinations: [], relatedSkills: [], unknownExternalReferences: [],
      }),
      commitDelete: vi.fn(),
    };
    renderLibrary({ facade, removalFacade });

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select PDF Reader" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected Skills from library" }));
    await screen.findByRole("dialog", { name: "Review batch deletion impact" });
    fireEvent.click(
      await within(screen.getByTestId("drawer-panel")).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() => expect(screen.queryByTestId("drawer-panel")).not.toBeInTheDocument());
    expect(removalFacade.commitDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Select PDF Reader" })).toBeChecked();
    expect(screen.getByRole("complementary", { name: "Batch actions" })).toBeVisible();
  });

  it("sends success outcomes to the auto-dismissing global toast instead of a local notice list (M-21)", async () => {
    vi.useFakeTimers();
    try {
      const facade = createMockSkillLibraryFacade();
      renderLibrary({ facade });

      // 假计时器下用显式推进驱动微任务/查询，不用依赖定时器轮询的 findBy。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      fireEvent.click(screen.getByRole("checkbox", { name: "Select PDF Reader" }));
      fireEvent.click(screen.getByRole("button", { name: "Add tags" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      const dialog = screen.getByRole("dialog", { name: "Add tags" });
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Tags" }), {
        target: { value: "review" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Add tags" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      // 成功结果走全局 toast（success tone），且页面容器内不再有局部通知列表。
      const toast = screen.getByTestId("notice-success");
      const workspace = document.querySelector(".sh-skill-library") as HTMLElement;
      expect(workspace.querySelector(".sh-notification-center")).toBeNull();
      expect(toast).toHaveTextContent("Batch tag update finished");

      // 全局契约：2 秒后 toast 自动消退（含 160ms 滑出）。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2400);
      });
      expect(screen.queryByTestId("notice-success")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it("previews selected Skills and requires a forced-delete confirmation before committing", async () => {
    const facade = createMockSkillLibraryFacade();
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        deployments: [], dependentProjects: [], operationId: "delete-pdf", skillId: "skill-pdf", skillName: "PDF Reader",
        declaredDependencies: [], pinnedVersions: [], combinations: [], relatedSkills: [], unknownExternalReferences: [],
      }),
      commitDelete: vi.fn().mockResolvedValue({ centralSkillDeleted: true }),
    };
    renderLibrary({ facade, removalFacade });

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select PDF Reader" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected Skills from library" }));
    expect(await screen.findByRole("dialog", { name: "Review batch deletion impact" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Continue to force deletion" }));
    // QA-001：二次点击确认取代 FORCE DELETE 文本输入。
    fireEvent.click(screen.getByRole("button", { name: "Click again to confirm deleting 1 Skills" }));

    await waitFor(() => expect(removalFacade.commitDelete).toHaveBeenCalledWith("delete-pdf", {}));
  });

  it("reports per-skill batch deletion outcomes instead of failing the whole batch", async () => {
    const facade = createMockSkillLibraryFacade();
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn()
        .mockResolvedValueOnce({ deployments: [], dependentProjects: [], operationId: "delete-pdf", skillId: "skill-pdf", skillName: "PDF Reader", declaredDependencies: [], pinnedVersions: [], combinations: [], relatedSkills: [], unknownExternalReferences: [] })
        .mockResolvedValueOnce({ deployments: [], dependentProjects: [], operationId: "delete-docx", skillId: "skill-docx", skillName: "DOCX Writer", declaredDependencies: [], pinnedVersions: [], combinations: [], relatedSkills: [], unknownExternalReferences: [] }),
      commitDelete: vi.fn()
        .mockResolvedValueOnce({ centralSkillDeleted: true })
        .mockRejectedValueOnce(new Error("locked by another process")),
    };
    renderLibrary({ facade, removalFacade });

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select PDF Reader" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select DOCX Writer" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected Skills from library" }));
    expect(await screen.findByRole("dialog", { name: "Review batch deletion impact" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Continue to force deletion" }));
    fireEvent.click(screen.getByRole("button", { name: "Click again to confirm deleting 2 Skills" }));

    const summary = await screen.findByTestId("batch-summary");
    expect(summary).toHaveTextContent("1 succeeded");
    expect(summary).toHaveTextContent("1 failed");
    expect(screen.getAllByTestId("batch-outcome-failed")).toHaveLength(1);
  });

  it("offers the same safe deletion flow from a selected Skill's quick drawer", async () => {
    const facade = createMockSkillLibraryFacade();
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        deployments: [], dependentProjects: [], operationId: "delete-pdf", skillId: "skill-pdf", skillName: "PDF Reader",
        declaredDependencies: [], pinnedVersions: [], combinations: [], relatedSkills: [], unknownExternalReferences: [],
      }),
      commitDelete: vi.fn(),
    };
    renderLibrary({ facade, removalFacade });

    await screen.findByText("PDF Reader");
    fireEvent.click(skillNameCell("PDF Reader"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete from library" }));

    expect(await screen.findByRole("dialog", { name: "Review batch deletion impact" })).toBeVisible();
    expect(removalFacade.prepareDelete).toHaveBeenCalledWith("skill-pdf", "PDF Reader");
  });

  it("keeps search visible while secondary filters collapse in the library", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    const toggle = await screen.findByRole("button", { name: /Filters/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);

    expect(screen.getByRole("searchbox", { name: "Search skills" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Basic check" })).not.toBeInTheDocument();
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

  it("applies batch tag additions through per-skill metadata saves", async () => {
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
      // 标签写经 set_metadata 的读改写落地（生产 emitBatchIntent 未绑定）。
      expect(facade.calls.saveSkillMetadata).toContainEqual({
        skillId: "skill-pdf",
        patch: { tags: ["documents", "pdf", "review", "urgent"] },
      });
    });
    expect(facade.calls.emitBatchIntent).not.toContainEqual(
      expect.objectContaining({ action: "add_tag" }),
    );
  });

  it("submits the remaining tag set when removing tags in bulk", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove tags" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove tags" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Tags" }), {
      target: { value: "documents" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove tags" }));
    // P1-15：移除标签提交前有轻量预览确认步，确认后才写回元数据。
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm removal" }));

    await waitFor(() => {
      expect(facade.calls.saveSkillMetadata).toContainEqual({
        skillId: "skill-pdf",
        patch: { tags: ["pdf"] },
      });
    });
  });

  it("reports per-skill tag outcomes instead of failing the whole batch", async () => {
    const facade = createMockSkillLibraryFacade();
    const successfulSave = facade.saveSkillMetadata?.bind(facade);
    facade.saveSkillMetadata = async (skillId, patch) => {
      if (skillId === "skill-docx") {
        throw new Error("locked by another process");
      }
      await successfulSave?.(skillId, patch);
    };
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select DOCX Writer" }));
    fireEvent.click(screen.getByRole("button", { name: "Add tags" }));
    const dialog = await screen.findByRole("dialog", { name: "Add tags" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Tags" }), {
      target: { value: "review" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tags" }));

    const summary = await screen.findByTestId("batch-summary");
    expect(summary).toHaveTextContent("1 succeeded");
    expect(summary).toHaveTextContent("1 failed");
    expect(screen.getAllByTestId("batch-outcome-failed")).toHaveLength(1);
    expect(screen.getByText("locked by another process")).toBeVisible();
  });

  it("shows the runtime name beside the aliased display name on cards", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade, persistedViewMode: "unset" });

    const card = await screen.findByTestId("skill-card-skill-pdf");
    expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    expect(within(card).getByText("pdf-reader")).toHaveClass(
      "sh-skill-card__subtitle",
    );
  });

  it("orders batch actions from high-frequency flows to a separated destructive group", async () => {
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
      // 高频：部署、标签、导出、检查更新
      "Deploy…",
      "Add tags",
      "Remove tags",
      "Start export",
      // 管理类
      "Run security check",
      "Submit export job",
      "Archive",
      // 破坏性操作单独分组且位于最右侧
      "Delete selected Skills from library",
    ]);
    const destructive = (actions as HTMLElement).querySelector(
      ".sh-skill-library__batch-destructive",
    );
    expect(destructive).not.toBeNull();
    expect(
      within(destructive as HTMLElement).getByRole("button", {
        name: "Delete selected Skills from library",
      }),
    ).toBeInTheDocument();
    // “清除选择”保持轻量操作，与批量动作分离且不占用破坏性分组位置
    expect(
      within(batchBar).getByRole("button", { name: "Clear selection" }),
    ).toHaveClass("sh-button--ghost");
  });

  it("downgrades batch deletion to a secondary action while keeping the force-delete flow", async () => {
    const facade = createMockSkillLibraryFacade();
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        deployments: [], dependentProjects: [], operationId: "delete-pdf", skillId: "skill-pdf", skillName: "PDF Reader",
        declaredDependencies: [], pinnedVersions: [], combinations: [], relatedSkills: [], unknownExternalReferences: [],
      }),
      commitDelete: vi.fn().mockResolvedValue({ centralSkillDeleted: true }),
    };
    renderLibrary({ facade, removalFacade });

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select PDF Reader" }));

    const batchBar = screen.getByRole("complementary", { name: "Batch actions" });
    const destructive = batchBar.querySelector(".sh-skill-library__batch-destructive");
    expect(destructive).not.toBeNull();
    const deleteButton = within(destructive as HTMLElement).getByRole("button", {
      name: "Delete selected Skills from library",
    });
    expect(deleteButton).toHaveClass("sh-button--ghost");
    expect(deleteButton).not.toHaveClass("sh-button--danger");

    fireEvent.click(deleteButton);
    expect(
      await screen.findByRole("dialog", { name: "Review batch deletion impact" }),
    ).toBeVisible();
  });

  it("keeps one control per batch behavior without duplicated accessible names", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );

    const batchBar = screen.getByRole("complementary", { name: "Batch actions" });
    const names = within(batchBar)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim());
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    // 语义重复的历史命名已消除：不再出现与“发起导出”难以区分的裸“Export”按钮
    expect(
      within(batchBar).queryByRole("button", { name: "Export" }),
    ).not.toBeInTheDocument();
  });

  it("distinguishes the export wizard entry from the native batch export submission", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );

    const batchBar = screen.getByRole("complementary", { name: "Batch actions" });
    const wizard = within(batchBar).getByRole("button", { name: "Start export" });
    const submission = within(batchBar).getByRole("button", { name: "Submit export job" });
    expect(wizard.getAttribute("title")).toBeTruthy();
    expect(submission.getAttribute("title")).toBeTruthy();
    expect(wizard.getAttribute("title")).not.toBe(submission.getAttribute("title"));
  });

  it("starts the standard export flow with the explicitly selected skill ids", async () => {
    const facade = createMockSkillLibraryFacade();
    const { router } = renderLibrary({ facade });

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select PDF Reader" }));
    fireEvent.click(screen.getByRole("button", { name: "Start export" }));

    expect(await screen.findByText("Data protection export")).toBeVisible();
    expect(router.state.location.pathname).toBe("/settings/data-protection");
    expect(router.state.location.state).toEqual({ exportSkillIds: ["skill-pdf"] });
  });

  it("carries every filtered skill id when the export entry runs on an all-filtered selection", async () => {
    const facade = createMockSkillLibraryFacade({ total: 80 });
    const { router } = renderLibrary({ facade });

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select current page" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all 80 filtered results" }));
    fireEvent.click(screen.getByRole("button", { name: "Start export" }));

    expect(await screen.findByText("Data protection export")).toBeVisible();
    expect(router.state.location.pathname).toBe("/settings/data-protection");
    const state = router.state.location.state as { exportSkillIds: string[] };
    expect(state.exportSkillIds).toHaveLength(80);
    expect(state.exportSkillIds).toEqual(expect.arrayContaining(["skill-pdf", "skill-docx", "skill-browser"]));
  });

  it("keeps the library in place when resolving filtered ids for export fails", async () => {
    const facade = createMockSkillLibraryFacade({ total: 80 });
    const { router } = renderLibrary({ facade });

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select current page" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all 80 filtered results" }));
    facade.listSkills = () => Promise.reject(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Start export" }));

    // 批量错误经通知中心以危险通知呈现（role=alert、常驻可关闭）。
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The batch workflow could not be started",
    );
    expect(screen.queryByText("Data protection export")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/library");
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

  it("closes the drawer while preserving the latest URL filters", async () => {
    const facade = createMockSkillLibraryFacade();
    const view = renderLibrary({
      facade,
      initialEntry: "/library?q=pdf&page=1&skill=skill-pdf",
    });

    await act(async () => {
      await view.router.navigate(
        "/library?q=reader&page=2&skill=skill-pdf",
      );
    });
    const close = await screen.findByRole("button", { name: "Close" });
    fireEvent.click(close);

    expect(view.router.state.location.search).toBe("?q=reader&page=2");
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

    expect(await screen.findByRole("status", { name: "Loading skill library" })).toHaveTextContent(
      "Loading skill library",
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
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

    expect(await screen.findByRole("status", { name: "Loading skill library" })).toHaveTextContent(
      "Loading skill library",
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
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
    const onOpenDiscovery = vi.fn();
    const first = renderLibrary({ facade: emptyLibrary, onOpenDiscovery });

    expect(await screen.findByText("No skills are in the library yet")).toBeVisible();
    expect(screen.getByText("Import is not connected yet")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open discovery" }));
    expect(onOpenDiscovery).toHaveBeenCalledOnce();

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

  it("uses the unified control classes for the save-view form and the mode switches", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade, persistedViewMode: "unset" });

    expect(await screen.findByTestId("skill-card-skill-pdf")).toBeVisible();
    // P1-08：视图/分组切换是键盘可操作的分段按钮组（aria-pressed），不再是原生 select。
    const viewSwitch = screen.getByRole("group", { name: "View mode" });
    expect(within(viewSwitch).getByRole("button", { name: "Table view" })).toHaveAttribute("aria-pressed", "false");
    expect(within(viewSwitch).getByRole("button", { name: "Card view" })).toHaveAttribute("aria-pressed", "true");
    expect(within(viewSwitch).getByRole("button", { name: "Relations matrix" })).toHaveAttribute("aria-pressed", "false");
    const groupSwitch = screen.getByRole("group", { name: /Group by/ });
    expect(within(groupSwitch).getByRole("button", { name: "No grouping" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveClass("sh-input");
  });

  it("offers a current-page select-all in the card view with the same selection model", async () => {
    const facade = createMockSkillLibraryFacade({ total: 80 });
    renderLibrary({ facade, persistedViewMode: "unset" });

    await screen.findByTestId("skill-card-skill-pdf");
    expect(
      screen.getByRole("checkbox", { name: "Select current page" }),
    ).not.toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select current page" }));
    expect(screen.getByText("25 items selected on this page")).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Batch actions" })).toBeVisible();

    // all_filtered/explicit 差集与表格视图共用同一 SkillSelection 模型。
    fireEvent.click(screen.getByRole("checkbox", { name: "Select PDF Reader" }));
    expect(screen.getByText("24 items selected")).toBeVisible();
  });

  it("keeps the saved-views row collapsible while search and mode switches stay visible", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    await screen.findByRole("table");
    const toggle = screen.getByRole("button", { name: "Collapse view bar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Document tools" })).toBeVisible();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Document tools" })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search skills" })).toBeVisible();
    expect(screen.getByRole("group", { name: "View mode" })).toBeVisible();
  });

  it("marks the workspace batch-active so pagination reserves clearance", async () => {
    const facade = createMockSkillLibraryFacade({ total: 80 });
    renderLibrary({ facade, persistedViewMode: "unset" });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select current page" }),
    );

    const workspace = document.querySelector(".sh-skill-library");
    expect(workspace).toHaveClass("sh-skill-library--batch-active");
    // 卡片分页与表格分页都在批量条激活时获得 margin 预留（几何断言由 E2E 兜底）。
    expect(document.querySelector(".sh-skill-cards__pagination")).not.toBeNull();
    expect(getComputedStyle(document.querySelector(".sh-skill-library") as HTMLElement).getPropertyValue("--skill-batch-bar-height")).toBeDefined();
  });

  it("falls back to default view and group modes without error UI when preference reads fail", async () => {
    const facade = createMockSkillLibraryFacade();
    facade.loadViewMode = vi.fn(async () => {
      throw new Error("view mode read failed");
    });
    facade.loadGroupMode = vi.fn(async () => {
      throw new Error("group mode read failed");
    });
    renderLibrary({ facade, persistedViewMode: "unset" });

    // 静默回退是需求允许的路径：默认卡片视图正常渲染，无错误 UI、无崩溃。
    expect(await screen.findByTestId("skill-card-skill-pdf")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "View mode" })).toBeVisible();
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

    const savedView = await screen.findByRole("button", {
      name: "Deployed skills",
      pressed: true,
    });
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
    fireEvent.click(screen.getByRole("button", { name: "Submit export job" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This batch workflow is not connected",
    );
    expect(screen.queryByText("Export completed")).not.toBeInTheDocument();
  });


  it("defaults to the enhanced shared-card view with verifiable facts and stable actions", async () => {
    const facade = createMockSkillLibraryFacade({ total: 30 });
    facade.saveViewMode = vi.fn(async () => undefined);
    const { router } = renderLibrary({ facade, persistedViewMode: "unset" });

    // 默认即增强卡片视图：无需切换即可见共享 SkillCard 语义。
    const card = await screen.findByTestId("skill-card-skill-pdf");
    expect(card).toBeVisible();
    expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    expect(screen.getByText("Internal catalog")).toBeVisible();
    expect(screen.getByText("Read and extract PDFs")).toBeVisible();
    // C1 收口：卡片事实行展示当前版本；PDF mock 有可升级版本与高风险发现
    expect(card).toHaveTextContent(/1\.4\.0/);
    expect(screen.getByTestId("skill-card-upgrade-skill-pdf")).toBeVisible();
    expect(screen.getByTestId("skill-card-risk-skill-pdf")).toBeVisible();

    // P1-11 主次语义对调：卡区激活 → 快速抽屉；“查看”按钮 → 完整详情页。
    fireEvent.click(screen.getByRole("heading", { name: "PDF Reader" }));
    expect(await screen.findByTestId("skill-quick-drawer")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "View PDF Reader" }));
    expect(await screen.findByText("Skill detail page")).toBeVisible();
    expect(router.state.location.pathname).toBe("/library/skill-pdf");
    await act(async () => {
      await router.navigate("/library");
    });

    // 选择/批量操作语义在卡片视图内保持；选择框套用统一控件尺寸类。
    fireEvent.click(
      (await screen.findByTestId("skill-card-skill-pdf")).querySelector(
        "input[type='checkbox']",
      ) as HTMLInputElement,
    );
    expect(screen.getByRole("checkbox", { name: "Select PDF Reader" })).toHaveClass("sh-control-checkbox");
    expect(screen.getByRole("complementary", { name: "Batch actions" })).toBeVisible();

    // 卡片视图保留分页能力。
    expect(screen.getByRole("button", { name: "Next page" })).toBeVisible();
  });

  it("keeps the select control from activating the card body", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade, persistedViewMode: "unset" });

    fireEvent.click(
      (await screen.findByTestId("skill-card-skill-pdf")).querySelector(
        "input[type='checkbox']",
      ) as HTMLInputElement,
    );

    expect(screen.queryByTestId("skill-quick-drawer")).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Batch actions" })).toBeVisible();
    expect(screen.getByText("1 item selected")).toBeVisible();
  });

  it("keeps view-mode choice persistent when switching to the professional table", async () => {
    const facade = createMockSkillLibraryFacade();
    facade.saveViewMode = vi.fn(async () => undefined);
    renderLibrary({ facade, persistedViewMode: "unset" });

    await screen.findByTestId("skill-card-skill-pdf");

    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    expect(facade.saveViewMode).toHaveBeenCalledWith("table");
    expect(await screen.findByRole("table")).toBeVisible();
  });

  it("keeps the batch selection when switching between card and table views", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade, persistedViewMode: "unset" });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    expect(screen.getByRole("complementary", { name: "Batch actions" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    const table = await screen.findByRole("table");
    expect(table).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Select PDF Reader" })).toBeChecked();
  });

  it("shows a filter-scoped summary strip built from existing query fields", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    expect(await screen.findByTestId("library-summary-total")).toBeVisible();
    expect(screen.getByTestId("library-summary-total")).toHaveTextContent(
      /共 \d+ 个 Skill|skills match the current filters/,
    );
    expect(screen.getByTestId("library-summary-tags")).toHaveTextContent(
      /标签 \d+ 个|tags available/,
    );
  });


  it("toggles to the relations matrix view built from real deployment records", async () => {
    const facade = createMockSkillLibraryFacade();
    facade.loadViewMode = vi.fn(async () => "matrix" as const);
    facade.listDeployments = vi.fn(async () => [
      { id: "d1", skill_id: "skill-pdf", version_id: "v3", target_id: "target-codex", state: "active", mode: "managed_copy", managed: true, runtime_name: "pdf-reader", expected_hash: "h", observed_hash: "h" },
    ] as never);
    facade.listDeploymentTargets = vi.fn(async () => [
      { id: "target-codex", label: "Codex CLI", path: "C:/codex", available: true, physicalId: "p1", modes: ["managed_copy"] },
      { id: "target-claude", label: "Claude Code", path: "C:/claude", available: true, physicalId: "p2", modes: ["managed_copy"] },
    ] as never);
    renderLibrary({ facade });

    // 矩阵列：仅显示有部署关系的目标（列标签用已注册目标名）
    expect(await screen.findByText("Codex CLI")).toBeVisible();
    // 命中的 skill × target 单元格有部署标记
    const cell = await screen.findByTestId("matrix-skill-pdf-target-codex");
    expect(cell).toHaveTextContent("✓");
    // 未命中的单元格为空标记
    expect(screen.getByTestId("matrix-skill-docx-target-codex").textContent ?? "").not.toContain("✓");
    expect(facade.listDeployments).toHaveBeenCalled();
  });


  it("groups card view sections by tag when tag grouping is selected", async () => {
    const facade = createMockSkillLibraryFacade();
    facade.saveGroupMode = vi.fn(async () => undefined);
    renderLibrary({ facade });

    // 等数据加载完成，再切换视图与分组
    await screen.findByRole("checkbox", { name: "Select PDF Reader" });
    fireEvent.click(screen.getByRole("button", { name: "Card view" }));
    fireEvent.click(screen.getByRole("button", { name: "Group by tag" }));

    expect(facade.saveGroupMode).toHaveBeenCalledWith("tags");
    const headings = await screen.findAllByRole("heading", { name: "documents" });
    expect(headings.length).toBeGreaterThanOrEqual(1);
  });

  it("restores a persisted card view on load", async () => {
    const facade = createMockSkillLibraryFacade();
    facade.loadViewMode = vi.fn(async () => "cards" as const);
    renderLibrary({ facade });

    expect(await screen.findByTestId("skill-card-skill-pdf")).toBeVisible();
  });

  it("opens the unified deployment flow with every explicitly selected Skill", async () => {
    const facade = createMockSkillLibraryFacade();
    const view = renderLibrary({ facade });

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select PDF Reader" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select DOCX Writer" }));
    fireEvent.click(screen.getByRole("button", { name: "Deploy…" }));

    await screen.findByText("Batch deployment");
    expect(view.router.state.location.pathname).toBe("/deploy");
    expect(new URLSearchParams(view.router.state.location.search).getAll("skill")).toEqual(["skill-docx", "skill-pdf"]);
    expect(facade.calls.emitBatchIntent).not.toContainEqual(expect.objectContaining({ action: "add_to" }));
  });

  it("carries a reverse-launch target from agent or project detail into the deploy URL", async () => {
    const facade = createMockSkillLibraryFacade();
    const view = renderLibrary({
      facade,
      initialEntry: {
        pathname: "/library",
        state: { deployTarget: { id: "codex-cli", label: "Codex CLI" } },
      },
    });

    // 预选目标提示可见
    expect(await screen.findByText(/Codex CLI/)).toBeVisible();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select PDF Reader" }));
    fireEvent.click(screen.getByRole("button", { name: "Deploy…" }));

    await screen.findByText("Batch deployment");
    const params = new URLSearchParams(view.router.state.location.search);
    expect(params.get("target")).toBe("codex-cli");
    expect(params.getAll("skill")).toContain("skill-pdf");
  });

  it("clears stale batch error notices when the selected scope changes", async () => {
    const facade = createMockSkillLibraryFacade();
    vi.spyOn(facade, "emitBatchIntent").mockRejectedValue(
      new Error("batch preparation failed"),
    );
    renderLibrary({ facade });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select PDF Reader" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit export job" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The batch workflow could not be started",
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select DOCX Writer" }));

    // 选择范围变化后，过期批量错误通知随“batch”类撤销，避免误归因到新选择。
    expect(screen.getByText("2 items selected")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText("The batch workflow could not be started"),
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

  it("opens silently with default preferences when none were ever stored (M-21)", async () => {
    // 首次打开：偏好从未存储（读取正常返回空），不得出现
    // “无法加载表格偏好”错误——默认值静默生效。
    const facade = createMockSkillLibraryFacade();
    vi.spyOn(facade, "loadTablePreferences").mockResolvedValue(null);
    vi.spyOn(facade, "loadDrawerPreferences").mockResolvedValue(null);
    renderLibrary({ facade });

    expect(await screen.findByRole("table")).toBeVisible();
    expect(
      screen.queryByRole("status", { name: "Preference status" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Table preferences could not be loaded/)).not.toBeInTheDocument();
    // 默认表格偏好静默生效：默认密度 compact 直接体现在表格上。
    expect(document.querySelector('table[data-density="compact"]')).not.toBeNull();
  });

  it("renders the purpose column with the user purpose first and the original description as fallback (M-21)", async () => {
    const facade = createMockSkillLibraryFacade({
      pageItems: [
        {
          ...MOCK_SKILL_DOCX,
          id: "skill-user-purpose",
          name: "User Purpose Skill",
          userPurpose: "用于合同扫描件归档",
          purpose: "用于合同扫描件归档",
          originalDescription: "Creates and updates Word documents.",
        },
        {
          ...MOCK_SKILL_DOCX,
          id: "skill-fallback-purpose",
          name: "Fallback Purpose Skill",
          userPurpose: undefined,
          purpose: "Creates and updates Word documents.",
          originalDescription: "Creates and updates Word documents.",
        },
      ],
      total: 2,
    });
    renderLibrary({ facade });

    await screen.findByRole("table");
    expect(screen.getByText("用于合同扫描件归档")).toBeVisible();
    // 用户未设置用途时，用途列回退 Skill 原始描述。
    expect(screen.getAllByText("Creates and updates Word documents.").length).toBeGreaterThanOrEqual(1);
  });

  it("exposes the reorganized IA with reachable roles, names and grouped toolbar levels (M-21)", async () => {
    const facade = createMockSkillLibraryFacade({ total: 80 });
    facade.listCombinations = vi.fn().mockResolvedValue([]);
    renderLibrary({ facade, persistedViewMode: "unset" });

    await screen.findByTestId("skill-card-skill-pdf");

    // 主搜索：searchbox 角色 + 可访问名称 + 键盘可达。
    const search = screen.getByRole("searchbox", { name: "Search skills" });
    search.focus();
    expect(search).toHaveFocus();

    // 结果摘要：工具栏常驻命中统计。
    expect(screen.getByTestId("library-summary-total")).toBeVisible();

    // 高级筛选：可展开控件带生效条件计数，展开后各筛选控件可达。
    const advanced = screen.getByRole("button", { name: /Filters/ });
    expect(advanced).toHaveAttribute("aria-expanded");
    if (advanced.getAttribute("aria-expanded") === "false") {
      fireEvent.click(advanced);
    }
    expect(screen.getByRole("button", { name: "Basic check" })).toBeVisible();

    // 组合管理入口：独立 link 角色 + 可聚焦（不内嵌面板，M-22 契约保持）。
    const combination = screen.getByRole("link", { name: "Combination manager" });
    combination.focus();
    expect(combination).toHaveFocus();
    expect(screen.queryByRole("button", { name: "New combination" })).toBeNull();

    // 工具栏层级：动作簇内以分隔符区隔视图切换组与管理入口组。
    const actions = document.querySelector(".sh-skill-library__toolbar-actions") as HTMLElement;
    expect(actions.querySelector(".sh-skill-library__toolbar-divider")).not.toBeNull();
    expect(getComputedStyle(actions.querySelector(".sh-skill-library__toolbar-divider") as HTMLElement).backgroundColor).toBeTruthy();
  });

  it("links to the combination manager instead of embedding the panel", async () => {
    const facade = createMockSkillLibraryFacade();
    facade.listCombinations = vi.fn().mockResolvedValue([]);
    const { router } = renderLibrary({ facade });

    // AR-022：库页只保留入口，不再内嵌组合面板。
    const entry = await screen.findByRole("link", { name: "Combination manager" });
    expect(entry).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New combination" })).toBeNull();

    fireEvent.click(entry);
    await waitFor(() => expect(router.state.location.pathname).toBe("/library/combinations"));
  });

  it("places the view switch and relation entry at the far right of the page toolbar (M-21)", async () => {
    const facade = createMockSkillLibraryFacade();
    facade.listCombinations = vi.fn().mockResolvedValue([]);
    renderLibrary({ facade, persistedViewMode: "unset" });

    await screen.findByTestId("skill-card-skill-pdf");

    // 结构接缝：动作簇是工具栏主行的最后一个区块，视图切换（含关系矩阵）
    // 与组合管理入口都收拢在动作簇内。
    const toolbarMain = document.querySelector(".sh-skill-library__toolbar-main");
    expect(toolbarMain).not.toBeNull();
    const actions = toolbarMain!.querySelector(".sh-skill-library__toolbar-actions");
    expect(actions).not.toBeNull();
    expect((actions as HTMLElement).nextElementSibling).toBeNull();

    const viewSwitch = within(actions as HTMLElement).getByRole("group", { name: "View mode" });
    expect(within(viewSwitch).getByRole("button", { name: "Table view" })).toBeTruthy();
    expect(within(viewSwitch).getByRole("button", { name: "Card view" })).toBeTruthy();
    expect(within(viewSwitch).getByRole("button", { name: "Relations matrix" })).toBeTruthy();
    expect(within(actions as HTMLElement).getByRole("link", { name: "Combination manager" })).toBeTruthy();

    // 右置契约：动作簇通过 margin-inline-start:auto 吸附到工具栏行最右
    // （jsdom 无布局引擎，几何右缘由浏览器/E2E 兑现）。
    expect(getComputedStyle(actions as HTMLElement).marginInlineStart).toBe("auto");

    // 键盘可达：每个视图按钮可聚焦且有可访问名称。
    for (const name of ["Table view", "Card view", "Relations matrix"]) {
      const button = within(viewSwitch).getByRole("button", { name });
      button.focus();
      expect(button).toHaveFocus();
    }
  });

  it("keeps icon-only view controls at the 40px interactive floor (M-21)", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    await screen.findByRole("table");
    const viewSwitch = screen.getByRole("group", { name: "View mode" });
    for (const button of within(viewSwitch).getAllByRole("button")) {
      const minHeight = getComputedStyle(button).minHeight;
      // 40px 图标按钮下限：2.5rem（声明值）或 40px（解析值）皆可接受。
      expect(minHeight === "2.5rem" || minHeight === "40px").toBe(true);
    }
  });

  it("renders the table view as the page's own scroll container with pagination below (M-21)", async () => {
    const facade = createMockSkillLibraryFacade();
    renderLibrary({ facade });

    await screen.findByRole("table");
    const workspace = document.querySelector(".sh-skill-library");
    expect(workspace).toHaveClass("sh-skill-library--table-view");

    // 表格区域自成滚动容器：横向与纵向滚动都发生在结果区域内。
    const region = screen.getByRole("region", { name: "Skill results" });
    expect(getComputedStyle(region).overflowX).toBe("auto");
    expect(getComputedStyle(region).overflowY).toBe("auto");

    // 纵向空间归表格区域：工作区行模板恢复弹性中行，结果区域外壳 min-height:0。
    const shell = region.closest(".sh-skill-table__region-shell") as HTMLElement;
    const tableWorkspace = document.querySelector(".sh-skill-table-workspace") as HTMLElement;
    expect(getComputedStyle(tableWorkspace).gridTemplateRows).toContain("minmax(0");
    // jsdom 对 0 的解析可能带或不带 px 单位。
    expect(["0", "0px"]).toContain(getComputedStyle(shell).minHeight);

    // 分页条固定在表格下方、不压叠：分页是外壳的后继兄弟节点，不在滚动容器内。
    const pagination = document.querySelector(".sh-skill-table__pagination") as HTMLElement;
    expect(pagination).not.toBeNull();
    expect(shell.nextElementSibling).toBe(pagination);
    expect(region.contains(pagination)).toBe(false);
  });
});
