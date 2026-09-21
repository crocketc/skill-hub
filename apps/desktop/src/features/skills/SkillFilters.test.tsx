import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { vi, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import baseCss from "../../styles/base.css?raw";
import skillsCss from "./skills.css?raw";
import {
  DEFAULT_SKILL_QUERY,
  DEFAULT_TABLE_PREFERENCES,
  type SavedSkillView,
  type SkillLibraryQuery,
} from "./api";
import { SkillFilters, type SkillFiltersProps } from "./SkillFilters";
import { SavedViews, type SavedViewsProps } from "./SavedViews";

function ClearHarness() {
  const [query, setQuery] = useState<SkillLibraryQuery>({
    ...DEFAULT_SKILL_QUERY,
    filters: { ...DEFAULT_SKILL_QUERY.filters, basicCheck: ["failed"] },
    pageSize: 50,
    text: "reader",
  });

  return (
    <>
      <SkillFilters
        availableTags={[]}
        onChange={setQuery}
        onClear={() => setQuery({ ...DEFAULT_SKILL_QUERY, pageSize: query.pageSize })}
        query={query}
      />
      <output>{query.pageSize}</output>
    </>
  );
}

async function renderSkillFilters(props: Partial<SkillFiltersProps> = {}) {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <SkillFilters
        availableTags={["docs", "pdf"]}
        onChange={vi.fn()}
        onClear={vi.fn()}
        query={DEFAULT_SKILL_QUERY}
        {...props}
      />
    </I18nextProvider>,
  );
}

async function renderSavedViews(props: Partial<SavedViewsProps> = {}) {
  const i18n = await createSkillHubI18n(["en-US"]);
  const view: SavedSkillView = {
    builtIn: false,
    id: "view-risk",
    name: "Risk review",
    query: {
      filters: DEFAULT_SKILL_QUERY.filters,
      sort: DEFAULT_SKILL_QUERY.sort,
      text: "",
    },
    table: DEFAULT_TABLE_PREFERENCES,
  };

  render(
    <I18nextProvider i18n={i18n}>
      <SavedViews dirty={false} onApply={vi.fn()} onSave={vi.fn()} views={[view]} {...props} />
    </I18nextProvider>,
  );
}

it("emits a page-reset query when search or filters change", async () => {
  const onChange = vi.fn();
  await renderSkillFilters({ onChange, query: { ...DEFAULT_SKILL_QUERY, page: 4 } });

  fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
    target: { value: "pdf" },
  });

  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 1, text: "pdf", savedViewId: undefined }),
  );
});

it("emits a page-reset query when a filter changes", async () => {
  const onChange = vi.fn();
  await renderSkillFilters({ onChange, query: { ...DEFAULT_SKILL_QUERY, page: 4 } });
  fireEvent.click(screen.getByRole("button", { name: "Basic check" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Failed" }));

  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      filters: expect.objectContaining({ basicCheck: ["failed"] }),
      page: 1,
      savedViewId: undefined,
    }),
  );
});

it("uses the unified control classes for search and dropdown filters", async () => {
  await renderSkillFilters();

  expect(screen.getByRole("searchbox", { name: "Search skills" })).toHaveClass("sh-input");
  expect(screen.getByRole("combobox", { name: "Added to targets" })).toHaveClass("sh-select");
  expect(screen.getByRole("combobox", { name: /Version/ })).toHaveClass("sh-select");
});

// M-21 IA：高级筛选带统一为「标签在上、控件在下」的等高 Field 网格。
// 裸 label（部署状态/版本）此前缺失 grid 布局类，是版本下拉悬空的根因。
it("places every advanced filter on the shared field grid with the label above the control", async () => {
  await renderSkillFilters();

  for (const name of ["Added to targets", /Version/]) {
    const field = screen.getByRole("combobox", { name }).closest("label");
    expect(field).toHaveClass("sh-skill-filters__field");
  }
  // 多值筛选与裸字段共用同一字段网格行（等高、标签在上）。
  for (const name of ["Basic check", "AI check", "Lifecycle", "Tags"]) {
    expect(screen.getByText(name, { selector: ".sh-filter-dropdown__label" })).toBeVisible();
  }
});

it("themes the multi-select trigger to the shared control box inside the library field grid", () => {
  // 触发器此前无控件盒（无描边/高度），与 Select 视觉断裂。
  expect(skillsCss).toMatch(
    /\.sh-skill-library \.sh-skill-filters__advanced \.sh-filter-dropdown__trigger\s*\{[^}]*min-height:\s*2\.5rem/,
  );
  expect(skillsCss).toMatch(
    /\.sh-skill-library \.sh-skill-filters__advanced \.sh-filter-dropdown__trigger\s*\{[^}]*border:\s*1px solid var\(--ui-control-border\)/,
  );
  // 字段网格：等宽下限 11rem，标签在上控件在下。
  expect(skillsCss).toMatch(
    /\.sh-skill-library \.sh-skill-filters__advanced\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(11rem,\s*1fr\)\)/,
  );
  expect(skillsCss).toMatch(/\.sh-skill-filters__field\s*\{[^}]*display:\s*grid/);
});

it("keeps multi-value filters inside a compact dropdown menu", async () => {
  await renderSkillFilters();
  expect(screen.getByText("Basic check", { selector: ".sh-filter-dropdown__label" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Tags" }));
  expect(screen.getByRole("menu", { name: "Tags" })).toBeVisible();
  expect(screen.getByRole("menuitemcheckbox", { name: "docs" })).toBeVisible();
  expect(screen.queryByRole("listbox", { name: "Tags" })).not.toBeInTheDocument();
});

it("closes an open multi-value filter when focus moves outside the menu", async () => {
  await renderSkillFilters();
  fireEvent.click(screen.getByRole("button", { name: "Tags" }));
  expect(screen.getByRole("menu", { name: "Tags" })).toBeVisible();

  fireEvent.pointerDown(document.body);

  expect(screen.queryByRole("menu", { name: "Tags" })).not.toBeInTheDocument();
});

it("delegates clearing to controlled state while preserving page size", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ClearHarness />
    </I18nextProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

  expect(screen.getByRole("searchbox", { name: "Search skills" })).toHaveValue("");
  expect(screen.getByRole("status")).toHaveTextContent("50");
});

it("does not repeat the result total inside the filter controls", async () => {
  await renderSkillFilters();

  expect(screen.queryByText(/results/i)).not.toBeInTheDocument();
});

it("applies a saved view and exposes dirty state without saving page or selection", async () => {
  const onApply = vi.fn();
  await renderSavedViews({ activeViewId: "view-risk", dirty: true, onApply });

  expect(screen.getByText("Unsaved changes")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Risk review" }));

  expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: "view-risk" }));
});

it("translates built-in view labels and preserves user labels verbatim", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const views: SavedSkillView[] = [
    {
      builtIn: true,
      id: "active",
      name: "skillLibrary.savedViews.builtIn.active",
      query: { filters: DEFAULT_SKILL_QUERY.filters, sort: DEFAULT_SKILL_QUERY.sort, text: "" },
      table: DEFAULT_TABLE_PREFERENCES,
    },
    {
      builtIn: false,
      id: "view-custom",
      name: "Custom review",
      query: { filters: DEFAULT_SKILL_QUERY.filters, sort: DEFAULT_SKILL_QUERY.sort, text: "" },
      table: DEFAULT_TABLE_PREFERENCES,
    },
  ];

  render(
    <I18nextProvider i18n={i18n}>
      <SavedViews dirty={false} onApply={vi.fn()} onSave={vi.fn()} views={views} />
    </I18nextProvider>,
  );

  expect(screen.getByRole("button", { name: "活跃" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Custom review" })).toBeVisible();
});

it("places user views after the first four in a labelled details menu", async () => {
  const views = Array.from({ length: 5 }, (_, index): SavedSkillView => ({
    builtIn: false,
    id: `view-${index + 1}`,
    name: `View ${index + 1}`,
    query: { filters: DEFAULT_SKILL_QUERY.filters, sort: DEFAULT_SKILL_QUERY.sort, text: "" },
    table: DEFAULT_TABLE_PREFERENCES,
  }));
  await renderSavedViews({ views });

  const moreViews = screen.getByText("More views", { selector: "summary" }).closest("details");
  if (!moreViews) throw new Error("Expected the overflow details menu");
  expect(moreViews).not.toHaveAttribute("open");
  expect(screen.getByText("View 5").closest("details")).toBe(moreViews);

  fireEvent.click(screen.getByText("More views"));

  expect(moreViews).toHaveAttribute("open");
});

// —— D5 契约迁移：base.css 的 .sh-skill-library__query-tools* 网格已随
// M-21 三 band 工具栏成为死代码并删除；下列断言改锁 skills.css 的现行
// 布局契约（自动换行网格 / 有界搜索字段 / 按簇折行的检索带）。 ——

it("wraps the advanced filter grid before zoomed desktop widths can overflow", () => {
  // 现行契约：高级筛选带用 auto-fit 网格，窄宽按 11rem 下限折行，不横向溢出。
  expect(skillsCss).toMatch(
    /\.sh-skill-library \.sh-skill-filters__advanced\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit, minmax\(11rem, 1fr\)\)/,
  );
  // 遗留风险清理（2026-09-14）：锁强化——base.css 不再含任何 query-tools 痕迹。
  expect(baseCss).not.toContain("query-tools");
});

it("keeps the search field bounded inside the primary filter row", () => {
  // 现行契约：搜索字段 min-width:0 可收缩，flex-basis 14rem 保持可点宽度。
  expect(skillsCss).toMatch(
    /\.sh-skill-filters__primary > \.sh-filter-search\s*\{[\s\S]*?min-width:\s*0[\s\S]*?flex:\s*1 1 14rem/,
  );
});

it("keeps the search band on one compact row that wraps by cluster", () => {
  // 现行契约：检索带整簇折行（flex-wrap），搜索簇以 36rem 上限参与空间平衡，
  // 100%/110% 缩放下先整簇换行而非控件散架。
  const bandStart = skillsCss.indexOf(".sh-skill-library__band--search {");
  expect(bandStart).toBeGreaterThanOrEqual(0);
  const bandBlock = skillsCss.slice(bandStart, skillsCss.indexOf("}", bandStart));
  expect(bandBlock).toContain("flex-wrap: wrap");
  expect(skillsCss).toMatch(
    /\.sh-skill-library__band--search > \.sh-skill-filters\s*\{[\s\S]*?flex:\s*0 1 36rem[\s\S]*?width:\s*100%[\s\S]*?max-width:\s*36rem/,
  );
});

it("keeps the desktop shell fixed while enabling outer scroll only for wrapped zoom", () => {
  expect(baseCss).toMatch(/\.sh-app-shell__content\s*\{[\s\S]*overflow-y:\s*hidden/);
  const wrappedStart = baseCss.indexOf("@media (max-width: 90rem)");
  const wrappedEnd = baseCss.indexOf("@media (max-width: 48rem)", wrappedStart);
  expect(baseCss.slice(wrappedStart, wrappedEnd)).toMatch(/\.sh-app-shell__content\s*\{[\s\S]*overflow-y:\s*auto/);
});

it("lets the table workspace fill the remaining library height", () => {
  expect(baseCss).toMatch(/\.sh-skill-library\s*\{[\s\S]*display:\s*flex[\s\S]*height:\s*100%/);
  expect(baseCss).toMatch(/\.sh-skill-table-workspace\s*\{[\s\S]*min-height:\s*0[\s\S]*flex:\s*1 1 auto/);
});

it("uses compact spacing between the library controls and results", () => {
  expect(baseCss).toMatch(/\.sh-skill-library\s*\{[\s\S]*gap:\s*var\(--space-2\)/);
});

it("keeps the search field reachable while secondary filters are collapsed", async () => {
  await renderSkillFilters();

  fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

  expect(screen.getByRole("searchbox", { name: "Search skills" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Basic check" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Tags" })).not.toBeInTheDocument();
});

it("keeps secondary filters expandable again after collapsing", async () => {
  await renderSkillFilters();

  const toggle = screen.getByRole("button", { name: /Filters/ });
  fireEvent.click(toggle);
  fireEvent.click(toggle);

  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "Basic check" })).toBeVisible();
});

it("announces the number of active conditions on the filter toggle", async () => {
  await renderSkillFilters({
    query: {
      ...DEFAULT_SKILL_QUERY,
      filters: { ...DEFAULT_SKILL_QUERY.filters, basicCheck: ["failed"] },
      text: "reader",
    },
  });

  expect(screen.getByRole("button", { name: /Filters 2 active/ })).toBeVisible();
  // 生成条件生效时保留一键清除入口。
  expect(screen.getByRole("button", { name: "Clear filters" })).toBeVisible();
});

it("starts with secondary filters collapsed on narrow windows", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: true }),
  );
  try {
    await renderSkillFilters();

    expect(screen.getByRole("searchbox", { name: "Search skills" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Basic check" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveAttribute("aria-expanded", "false");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps secondary filters expanded on wide windows", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false }),
  );
  try {
    await renderSkillFilters();

    expect(screen.getByRole("button", { name: /Filters/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Basic check" })).toBeVisible();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("replaces the character-glyph view delete with a labelled icon button", async () => {
  await renderSavedViews({ onDelete: vi.fn() });

  const remove = screen.getByRole("button", { name: "Delete Risk review" });
  expect(remove).toBeVisible();
  expect(remove).not.toHaveTextContent("×");
});

it("disables the upgrade filter while upstream update data has no read model", async () => {
  await renderSkillFilters({ versionFilterSupported: false });

  const versionSelect = screen.getByRole("combobox", { name: /Version/ });
  expect(versionSelect).toBeDisabled();
  expect(versionSelect).toHaveAccessibleDescription(
    "Upgrade detection has not been connected yet.",
  );
  expect(screen.getByRole("combobox", { name: "Added to targets" })).toBeEnabled();
});
