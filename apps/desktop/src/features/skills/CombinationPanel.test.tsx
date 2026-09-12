import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createSkillHubI18n } from "../../i18n";
import { CombinationPanel } from "./CombinationPanel";
import type { SkillLibraryQuery } from "./api";
import type { CombinationResult } from "../../api/bindings";

const combinations: CombinationResult[] = [
  { name: "Writing stack", members: ["skill-1", "skill-2"] },
];

const candidateItems = [
  { id: "skill-1", name: "PDF" },
  { id: "skill-2", name: "Notes" },
];

function createFacade(overrides: Record<string, unknown> = {}) {
  return {
    listSkills: vi.fn().mockResolvedValue({
      items: candidateItems.map((item) => ({ ...item })),
      facets: { tags: ["documents"] },
      page: 1,
      pageSize: 50,
      total: candidateItems.length,
    }),
    listCombinations: vi.fn().mockResolvedValue(combinations),
    createCombination: vi.fn().mockResolvedValue(undefined),
    updateCombination: vi.fn().mockResolvedValue(undefined),
    deleteCombination: vi.fn().mockResolvedValue(undefined),
    // renameCombination 是可选能力：缺省 undefined 时面板隐藏重命名入口。
    renameCombination: undefined,
    exportCombination: vi.fn().mockResolvedValue({ path: "C:/exports/skillhub-export-1.zip" }),
    ...overrides,
  };
}

async function renderPanel(facade: ReturnType<typeof createFacade>) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let location: { pathname: string; search: string } | undefined;
  function LocationProbe() {
    location = useLocation();
    return null;
  }
  const result = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <CombinationPanel
            facade={facade as never}
            skillNames={{ "skill-1": "PDF", "skill-2": "Notes" }}
          />
          <LocationProbe />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...result, getLocation: () => location };
}

describe("CombinationPanel", () => {
  it("lists combinations with per-member display names and supports deletion after a confirm dialog", async () => {
    const facade = createFacade();
    await renderPanel(facade);
    expect(await screen.findByText("Writing stack")).toBeVisible();
    // 成员逐个以显示名呈现，并给出成员数量，而不是一行拼接字符串。
    expect(screen.getByText("PDF")).toBeVisible();
    expect(screen.getByText("Notes")).toBeVisible();
    expect(screen.getByText("成员（2）")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "删除组合 Writing stack" }));
    const dialog = screen.getByRole("alertdialog", { name: "删除组合 Writing stack" });
    // 删除前如实展示影响：成员数量 + 只删组合记录、不动 Skill/部署/文件。
    expect(within(dialog).getByText(/包含 2 个成员/)).toBeVisible();
    expect(within(dialog).getByText(/不影响库中的 Skill、部署与文件/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(facade.deleteCombination).toHaveBeenCalledWith("Writing stack"));
    await waitFor(() => expect(facade.listCombinations).toHaveBeenCalledTimes(2));
  });

  it("picks members from the queried candidate list and creates the combination", async () => {
    const facade = createFacade();
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "新建组合" }));
    // 候选成员来自真实的 listSkills 查询，而不是组件外部一次性传入。
    await waitFor(() =>
      expect(facade.listSkills).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, text: "" }),
      ),
    );
    fireEvent.change(screen.getByLabelText("组合名称"), { target: { value: "Reading" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "PDF" }));
    fireEvent.click(screen.getByRole("button", { name: "保存组合" }));
    await waitFor(() =>
      expect(facade.createCombination).toHaveBeenCalledWith("Reading", ["skill-1"]),
    );
  });

  it("narrows member candidates by text and tag before selection", async () => {
    const facade = createFacade({
      listSkills: vi.fn(async (query: SkillLibraryQuery) => {
        const text = query.text.trim();
        const items = text
          ? candidateItems.filter((item) => item.name.includes(text))
          : candidateItems;
        return {
          items: items.map((item) => ({ ...item })),
          facets: { tags: ["documents"] },
          page: query.page,
          pageSize: query.pageSize,
          total: items.length,
        };
      }),
    });
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "新建组合" }));
    expect(await screen.findByRole("checkbox", { name: "PDF" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Notes" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("按名称筛选"), { target: { value: "PDF" } });
    await waitFor(() =>
      expect(facade.listSkills).toHaveBeenCalledWith(
        expect.objectContaining({ text: "PDF", page: 1 }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Notes" })).toBeNull(),
    );
    expect(screen.getByRole("checkbox", { name: "PDF" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("按标签筛选"), { target: { value: "documents" } });
    await waitFor(() =>
      expect(facade.listSkills).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({ tags: ["documents"] }),
        }),
      ),
    );
  });

  it("loads further candidate pages on demand instead of one fixed window", async () => {
    const all = Array.from({ length: 60 }, (_, index) => ({
      id: `candidate-${index + 1}`,
      name: `Candidate ${index + 1}`,
    }));
    const facade = createFacade({
      listSkills: vi.fn(async (query: SkillLibraryQuery) => ({
        items: all.slice((query.page - 1) * 50, query.page * 50).map((item) => ({ ...item })),
        facets: { tags: [] },
        page: query.page,
        pageSize: 50,
        total: all.length,
      })),
    });
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "新建组合" }));
    expect(await screen.findByRole("checkbox", { name: "Candidate 50" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Candidate 51" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加载更多候选 Skill" }));
    expect(await screen.findByRole("checkbox", { name: "Candidate 51" })).toBeVisible();
  });

  it("drops an in-flight loadMore response after the filter re-queries the list", async () => {
    let resolveStalePage2: (() => void) | undefined;
    const all = Array.from({ length: 60 }, (_, index) => ({
      id: `candidate-${index + 1}`,
      name: `Candidate ${index + 1}`,
    }));
    const facade = createFacade({
      listSkills: vi.fn((query: SkillLibraryQuery) => {
        if (query.page > 1) {
          return new Promise((resolve) => {
            resolveStalePage2 = () =>
              resolve({
                items: all.slice(50, 60).map((item) => ({ ...item })),
                facets: { tags: [] },
                page: query.page,
                pageSize: 50,
                total: all.length,
              });
          });
        }
        const filtered = query.text.trim()
          ? [{ id: "special", name: "Special match" }]
          : all.slice(0, 50);
        return Promise.resolve({
          items: filtered.map((item) => ({ ...item })),
          facets: { tags: [] },
          page: 1,
          pageSize: 50,
          total: query.text.trim() ? 1 : all.length,
        });
      }),
    });
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "新建组合" }));
    expect(await screen.findByRole("checkbox", { name: "Candidate 50" })).toBeVisible();

    // 第二页还在飞行中时更改筛选：page-1 立即按新条件重查并替换列表，
    // 迟到的第二页结果不允许拼进新筛选的列表。
    fireEvent.click(screen.getByRole("button", { name: "加载更多候选 Skill" }));
    const filter = screen.getByRole("searchbox", { name: "按名称筛选" });
    fireEvent.change(filter, { target: { value: "probe" } });
    expect(await screen.findByRole("checkbox", { name: "Special match" })).toBeVisible();

    resolveStalePage2?.();
    await waitFor(() => expect(facade.listSkills).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("checkbox", { name: "Candidate 51" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Special match" })).toBeVisible();
  });

  it("edits members of an existing combination through updateCombination", async () => {
    const facade = createFacade();
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "编辑成员 Writing stack" }));
    expect(await screen.findByRole("checkbox", { name: "PDF" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Notes" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Notes" }));
    fireEvent.click(screen.getByRole("button", { name: "保存成员" }));
    await waitFor(() =>
      expect(facade.updateCombination).toHaveBeenCalledWith("Writing stack", ["skill-1"]),
    );
  });

  it("rejects duplicate names inline without calling createCombination", async () => {
    const facade = createFacade();
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "新建组合" }));
    fireEvent.change(screen.getByLabelText("组合名称"), {
      target: { value: "  Writing stack  " },
    });
    fireEvent.click(await screen.findByRole("checkbox", { name: "PDF" }));
    fireEvent.click(screen.getByRole("button", { name: "保存组合" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/已存在同名组合「Writing stack」/);
    expect(facade.createCombination).not.toHaveBeenCalled();
  });

  it("renames a combination through the optional facade method and reports the new name", async () => {
    const facade = createFacade({
      renameCombination: vi
        .fn()
        .mockResolvedValue({ name: "Reading stack", members: ["skill-1", "skill-2"] }),
    });
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "重命名 Writing stack" }));
    fireEvent.change(screen.getByLabelText("新名称"), { target: { value: "Reading stack" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新名称" }));
    await waitFor(() =>
      expect(facade.renameCombination).toHaveBeenCalledWith("Writing stack", "Reading stack"),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/已重命名为/);
  });

  it("rejects renaming onto an existing other name inline without calling renameCombination", async () => {
    const facade = createFacade({
      renameCombination: vi.fn(),
      listCombinations: vi.fn().mockResolvedValue([
        { name: "Writing stack", members: ["skill-1"] },
        { name: "Reading stack", members: ["skill-2"] },
      ]),
    });
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "重命名 Writing stack" }));
    fireEvent.change(screen.getByLabelText("新名称"), { target: { value: "Reading stack" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新名称" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/已存在同名组合「Reading stack」/);
    expect(facade.renameCombination).not.toHaveBeenCalled();
  });

  it("hides the rename entry when the facade cannot rename combinations", async () => {
    const facade = createFacade();
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    expect(screen.queryByRole("button", { name: "重命名 Writing stack" })).toBeNull();
  });

  it("describes a legacy duplicate-name conflict in readable copy instead of raw codes", async () => {
    const facade = createFacade({
      deleteCombination: vi.fn().mockRejectedValue({
        code: "operation.conflict",
        severity: "error",
        params: { combination: "Writing stack", matches: 2 },
        actions: ["acknowledge"],
      }),
    });
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "删除组合 Writing stack" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/2 个同名组合「Writing stack」/);
  });

  it("exports a combination through the standard export and shows the result path", async () => {
    const facade = createFacade();
    const { getLocation } = await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "导出组合 Writing stack" }));
    expect(await screen.findByText(/skillhub-export-1.zip/)).toBeVisible();
    expect(facade.exportCombination).toHaveBeenCalledWith("Writing stack");
    expect(getLocation()?.pathname).toBe("/");
  });

  it("opens the batch deployment page with the members preselected", async () => {
    const facade = createFacade();
    const { getLocation } = await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "部署组合 Writing stack" }));
    await waitFor(() => expect(getLocation()?.pathname).toBe("/deploy"));
    const params = new URLSearchParams(getLocation()?.search);
    expect(params.getAll("skill")).toEqual(["skill-1", "skill-2"]);
  });
});
