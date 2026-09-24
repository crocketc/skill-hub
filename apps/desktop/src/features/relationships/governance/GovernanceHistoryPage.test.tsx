import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GovernanceHistoryEntry } from "../../../api/bindings";
import { createSkillHubI18n } from "../../../i18n";
import type { RelationGovernanceFacade } from "./api";
import { GovernanceHistoryPage } from "./GovernanceHistoryPage";
import { desktopDirectoryPicker } from "../../../platform/directoryPicker";

vi.mock("../../../platform/directoryPicker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/directoryPicker")>()),
  desktopDirectoryPicker: {
    pickDirectory: vi.fn<() => Promise<string | null>>(async () => null),
  },
}));

function historyEntry(overrides: Partial<GovernanceHistoryEntry> = {}): GovernanceHistoryEntry {
  return {
    relation_id: "src-1",
    skill_id: "skill-pdf",
    skill_display_name: "共享 PDF",
    agent: { client_id: "codex" },
    path: "C:\\agents\\codex\\skills\\pdf-reader",
    scope: "agent",
    project_id: null,
    action: "clean_source_copy",
    result: "committed",
    reason: null,
    operation_id: "op-child-1",
    occurred_at: "1727123456789",
    ...overrides,
  };
}

function createFacade(
  history: { items: GovernanceHistoryEntry[]; total: number; page: number; page_size: number },
  overrides: Partial<RelationGovernanceFacade> = {},
): RelationGovernanceFacade {
  return {
    listGovernance: vi.fn().mockResolvedValue({ counts: undefined, rows: [], total: 0 }),
    revalidate: vi.fn().mockResolvedValue({ items: [], relationship_revision: "1" }),
    listHistory: vi.fn().mockResolvedValue(history),
    retainSourceCopy: vi.fn().mockResolvedValue(undefined),
    relinkSourceCopy: vi.fn().mockResolvedValue(undefined),
    getRelationshipRemovalImpact: vi.fn().mockResolvedValue(undefined),
    prepareGovernanceBatch: vi.fn().mockResolvedValue(undefined),
    commitGovernanceBatch: vi.fn().mockResolvedValue(undefined),
    rollbackGovernanceBatch: vi.fn().mockResolvedValue(undefined),
    prepareRelationUndeploy: vi.fn().mockResolvedValue(undefined),
    commitRelationUndeploy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as RelationGovernanceFacade;
}

async function renderHistoryPage(facade: RelationGovernanceFacade) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/relationships/governance/history"]}>
          <GovernanceHistoryPage facade={facade} />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("GovernanceHistoryPage（任务 12A）", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders entries newest-first with honest action/result wording and failure reasons", async () => {
    const facade = createFacade({
      items: [
        historyEntry({
          relation_id: "src-old",
          action: "clean_source_copy",
          result: "committed",
          occurred_at: "1727100000000",
        }),
        historyEntry({
          relation_id: "src-new",
          action: "validate",
          result: "archived",
          reason: "external_removed",
          operation_id: null,
          occurred_at: "1727123456789",
        }),
      ],
      total: 2,
      page: 1,
      page_size: 20,
    });
    await renderHistoryPage(facade);

    await screen.findByTestId("governance-history-row-src-new");
    const pageEl = screen.getByTestId("governance-history-page");
    const rows = [...pageEl.querySelectorAll<HTMLElement>("tbody tr")];
    expect(rows).toHaveLength(2);
    // 时间倒序：新条目（validate/archived）在上。
    expect(rows[0]).toHaveAttribute("data-relation-id", "src-new");
    // ExternalRemoved 的诚实文案：来源已不存在，不冒充“SkillHub 已清理”。
    expect(within(rows[0]!).getByText("来源已不存在（外部删除）")).toBeVisible();
    expect(within(rows[0]!).queryByText("已清理来源副本")).not.toBeInTheDocument();
    // 旧条目：清理动作 + 已执行结果 + 对象与路径。
    expect(within(rows[1]!).getByTestId("governance-history-action-src-old")).toHaveTextContent(
      "清理来源副本",
    );
    expect(within(rows[1]!).getByTestId("governance-history-result-src-old")).toHaveTextContent(
      "已执行",
    );
    expect(within(rows[1]!).getByText("共享 PDF")).toBeVisible();
    expect(within(rows[1]!).getByText("C:\\agents\\codex\\skills\\pdf-reader")).toBeVisible();

    // 失败原因可见。
    const failing = createFacade({
      items: [historyEntry({
        relation_id: "src-fail",
        action: "clean_source_copy",
        result: "failed",
        reason: "internal.error",
      })],
      total: 1,
      page: 1,
      page_size: 20,
    });
    const { unmount } = render(
      <I18nextProvider i18n={await createSkillHubI18n(["zh-CN"])}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={["/relationships/governance/history"]}>
            <GovernanceHistoryPage facade={failing} />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    const failRow = await screen.findByTestId("governance-history-row-src-fail");
    expect(failRow).toHaveTextContent("internal.error");
    unmount();
  });

  it("offers relink for external-removed entries through the directory picker and refreshes afterwards", async () => {
    const pickDirectory = vi.mocked(desktopDirectoryPicker.pickDirectory);
    pickDirectory.mockResolvedValue("C:\\picked\\new-home");
    const facade = createFacade({
      items: [
        historyEntry({
          relation_id: "src-archived",
          action: "validate",
          result: "archived",
          reason: "external_removed",
          operation_id: null,
        }),
        historyEntry({
          relation_id: "src-ok",
          action: "clean_source_copy",
          result: "committed",
        }),
      ],
      total: 2,
      page: 1,
      page_size: 20,
    });
    await renderHistoryPage(facade);

    // 仅 ExternalRemoved 条目提供重新关联；已执行条目没有。
    const archivedRow = await screen.findByTestId("governance-history-row-src-archived");
    expect(within(archivedRow).getByTestId("governance-history-relink-src-archived")).toBeVisible();
    expect(screen.queryByTestId("governance-history-relink-src-ok")).not.toBeInTheDocument();

    // 经目录 picker 取得受控路径后调用 RelinkSourceCopy，成功后重新拉取历史。
    fireEvent.click(await screen.findByTestId("governance-history-relink-src-archived"));
    await waitFor(() => expect(facade.relinkSourceCopy).toHaveBeenCalledWith(
      "src-archived",
      "C:\\picked\\new-home",
    ));
    await waitFor(() => expect((facade.listHistory as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThanOrEqual(2));

    // 用户取消 picker：不调用后端。
    pickDirectory.mockResolvedValue(null);
    fireEvent.click(await screen.findByTestId("governance-history-relink-src-archived"));
    expect(facade.relinkSourceCopy).toHaveBeenCalledTimes(1);
  });

  it("links back to the governance list and paginates when more entries exist", async () => {
    const facade = createFacade({
      items: [historyEntry({ relation_id: "src-1" })],
      total: 25,
      page: 1,
      page_size: 20,
    });
    await renderHistoryPage(facade);

    // 与主治理页互相跳转。
    expect(await screen.findByTestId("governance-history-list-link")).toHaveAttribute(
      "href",
      "/relationships/governance",
    );

    // 有更多条目时提供翻页入口。
    fireEvent.click(await screen.findByTestId("governance-history-next-page"));
    await waitFor(() => expect(facade.listHistory).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 20 }),
    ));
  });
});
