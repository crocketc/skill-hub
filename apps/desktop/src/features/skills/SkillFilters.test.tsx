import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { vi, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { DEFAULT_SKILL_QUERY, DEFAULT_TABLE_PREFERENCES, type SavedSkillView } from "./api";
import { SkillFilters, type SkillFiltersProps } from "./SkillFilters";
import { SavedViews, type SavedViewsProps } from "./SavedViews";

async function renderSkillFilters(props: Partial<SkillFiltersProps> = {}) {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <SkillFilters
        availableTags={["docs", "pdf"]}
        onChange={vi.fn()}
        onClear={vi.fn()}
        query={DEFAULT_SKILL_QUERY}
        resultCount={0}
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

it("applies a saved view and exposes dirty state without saving page or selection", async () => {
  const onApply = vi.fn();
  await renderSavedViews({ activeViewId: "view-risk", dirty: true, onApply });

  expect(screen.getByText("Unsaved changes")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Risk review" }));

  expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: "view-risk" }));
});
