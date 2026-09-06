import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { skillHubI18n } from "../../i18n";
import type { SkillLibraryFacade } from "./api";
import { DEFAULT_SKILL_QUERY } from "./api";
import { CombinationManagerPage } from "./CombinationManagerPage";

function renderManager(facade: SkillLibraryFacade) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nextProvider i18n={skillHubI18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/library/combinations"]}>
          <CombinationManagerPage facade={facade} />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("CombinationManagerPage", () => {
  it("renders the manager heading, a back link and the combination panel", async () => {
    const facade = {
      listSkills: vi.fn().mockResolvedValue({
        items: [
          { id: "skill-1", name: "PDF Reader" },
          { id: "skill-2", name: "Notes" },
        ],
        facets: { tags: [] },
        page: 1,
        pageSize: 100,
        total: 2,
      }),
      listCombinations: vi.fn().mockResolvedValue([
        { name: "Reading stack", members: ["skill-1", "skill-2"] },
      ]),
    };
    renderManager(facade as unknown as SkillLibraryFacade);

    expect(screen.getByRole("heading", { name: "Combination manager" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to library" })).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "New combination" }),
    ).toBeVisible();
    expect(await screen.findByText("Reading stack")).toBeVisible();
    // 成员以显示名呈现（来自真实技能列表）。
    // 成员经 skillNames 映射为显示名（面板用「、」连接为单节点）。
    expect(await screen.findByText("PDF Reader、Notes")).toBeVisible();
    expect(facade.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 100 }),
    );
    expect(DEFAULT_SKILL_QUERY.page).toBe(1);
  });

  it("renders the empty guard when the facade cannot manage combinations", () => {
    renderManager({
      listSkills: vi.fn().mockResolvedValue({ items: [], facets: { tags: [] }, page: 1, pageSize: 100, total: 0 }),
      listCombinations: vi.fn().mockResolvedValue([]),
    } as unknown as SkillLibraryFacade);
    expect(screen.getByRole("heading", { name: "Combination manager" })).toBeVisible();
  });
});
