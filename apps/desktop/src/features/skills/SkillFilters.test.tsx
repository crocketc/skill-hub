import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { vi, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import baseCss from "../../styles/base.css?raw";
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

it("wraps the filter grid before zoomed desktop widths can overflow", () => {
  expect(baseCss).toMatch(
    /@media \(max-width: 112rem\)[\s\S]*\.sh-skill-library__query-tools > section\s*\{[\s\S]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)/,
  );
});

it("keeps the search field bounded inside the zoomed filter grid", () => {
  const zoomedStart = baseCss.indexOf("@media (max-width: 112rem)");
  const zoomedEnd = baseCss.indexOf("@media (max-width: 48rem)", zoomedStart);
  const zoomedLayout = baseCss.slice(zoomedStart, zoomedEnd);
  expect(zoomedLayout).toMatch(
    /\.sh-skill-library__query-tools > section > \.sh-filter-search\s*\{[\s\S]*grid-column:\s*auto/,
  );
});

it("uses compact spacing between the library controls and results", () => {
  expect(baseCss).toMatch(/\.sh-skill-library\s*\{[\s\S]*gap:\s*var\(--space-2\)/);
});
