import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { RelationshipsFacade } from "./api";
import { createSkillHubI18n } from "../../i18n";
import { RelationshipsLayout } from "./RelationshipsLayout";

async function renderLayout(scope: "graph" | "decisions" | "governance") {
  cleanup();
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/relationships"]}>
        <RelationshipsLayout scope={scope} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe("RelationshipsLayout", () => {
  it("leaves the module title to the app topbar and renders only the three workspace tabs", async () => {
    await renderLayout("graph");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Relationship sections" });
    expect(within(nav).getByRole("link", { name: "Skill graph" })).toBeVisible();
    expect(within(nav).getByRole("link", { name: "Conflict decisions" })).toBeVisible();
    expect(within(nav).getByRole("link", { name: "Relationship governance" })).toBeVisible();
    expect(within(nav).getAllByRole("link")).toHaveLength(3);
    expect(
      screen.getByText(
        "The relationship graph canvas is not available yet; relation facts stay available in the Skill library and on Skill details.",
      ),
    ).toBeVisible();

    await renderLayout("decisions");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();

    await renderLayout("governance");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("keeps the section navigation available without duplicating the topbar title", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/relationships"]}>
          <RelationshipsLayout scope="graph" />
        </MemoryRouter>
      </I18nextProvider>,
    );

    const nav = screen.getByRole("navigation", { name: "Relationship sections" });
    expect(nav).toHaveClass("sh-relationships__nav");
  });

  it("renders provided page content instead of the placeholder when a page supplies children", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/relationships"]}>
          <RelationshipsLayout scope="graph">
            <p>Real canvas content</p>
          </RelationshipsLayout>
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(screen.getByText("Real canvas content")).toBeVisible();
    expect(screen.getByText("Real canvas content").closest(".sh-page-frame")).toHaveClass(
      "sh-page-frame--fill",
    );
    expect(
      screen.queryByText(/not available yet/),
    ).not.toBeInTheDocument();
  });

  it("exposes in-page navigation between the three scopes with the active route marked", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/relationships"]}>
          <Routes>
            <Route element={<RelationshipsLayout scope="graph" />} path="/relationships" />
            <Route element={<RelationshipsLayout scope="decisions" />} path="/relationships/decisions" />
            <Route element={<RelationshipsLayout scope="governance" />} path="/relationships/governance" />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    );

    const nav = screen.getByRole("navigation", { name: "Relationship sections" });
    const graph = within(nav).getByRole("link", { name: "Skill graph" });
    expect(graph).toHaveClass("sh-relationships__nav-link--title-scale");
    expect(within(nav).getByRole("link", { name: "Conflict decisions" })).toHaveClass(
      "sh-relationships__nav-link--title-scale",
    );
    expect(within(nav).getByRole("link", { name: "Relationship governance" })).toHaveClass(
      "sh-relationships__nav-link--title-scale",
    );
    expect(graph).toHaveAttribute("href", "/relationships");
    expect(graph).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Conflict decisions" })).toHaveAttribute(
      "href",
      "/relationships/decisions",
    );
    expect(within(nav).getByRole("link", { name: "Relationship governance" })).toHaveAttribute(
      "href",
      "/relationships/governance",
    );
  });

  // DEV-90：「技能图谱」页签 to=/relationships 是其余子路由的前缀，未加
  // end 时在治理页会误激活。回归：三个页签中只有当前工作区带 aria-current。
  it("marks only the active workspace tab on subroutes", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/relationships/governance"]}>
          <Routes>
            <Route element={<RelationshipsLayout scope="graph" />} path="/relationships" />
            <Route element={<RelationshipsLayout scope="decisions" />} path="/relationships/decisions" />
            <Route element={<RelationshipsLayout scope="governance" />} path="/relationships/governance" />
            <Route element={<RelationshipsLayout scope="governance" />} path="/relationships/governance/history" />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    );

    const nav = screen.getByRole("navigation", { name: "Relationship sections" });
    expect(within(nav).getByRole("link", { name: "Relationship governance" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Skill graph" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Conflict decisions" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  // 治理历史页属于治理工作区：治理页签保持前缀匹配（不加 end），历史页仍高亮。
  it("keeps the governance tab active on the governance history page", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/relationships/governance/history"]}>
          <Routes>
            <Route element={<RelationshipsLayout scope="graph" />} path="/relationships" />
            <Route element={<RelationshipsLayout scope="decisions" />} path="/relationships/decisions" />
            <Route element={<RelationshipsLayout scope="governance" />} path="/relationships/governance" />
            <Route element={<RelationshipsLayout scope="governance" />} path="/relationships/governance/history" />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    );

    const nav = screen.getByRole("navigation", { name: "Relationship sections" });
    expect(within(nav).getByRole("link", { name: "Relationship governance" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Skill graph" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows relationship counts on the section badges once the shared queries land", async () => {
    const facade: RelationshipsFacade = {
      listCandidates: async () =>
        [
          { skill_id: "a", display_name: "A", runtime_name: "a", tags: [], matched_alias: null, relationship_count: 1, relationship_revision: "r1", last_verified_at: null },
          { skill_id: "b", display_name: "B", runtime_name: "b", tags: [], matched_alias: null, relationship_count: 1, relationship_revision: "r1", last_verified_at: null },
        ] as never,
      getGraph: async () => { throw new Error("not used here"); },
      getConflictWorkspace: async () =>
        ({ cases: [{ case: { conflict_id: "c1" }, handled: false }], handled_count: 0, handled: [], relationship_revision: "r1", last_verified_at: null }) as never,
      listGovernance: async () =>
        ({ rows: [], counts: { all: 5, eligible_to_centralize: 0, needs_validation: 0, blocked: 0 }, bucket: "all", total: 5, relationship_revision: "r1", last_verified_at: null }) as never,
    };
    const client = new QueryClient();
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/relationships/decisions"]}>
            <Routes>
              <Route element={<RelationshipsLayout facade={facade} scope="graph" />} path="/relationships" />
              <Route element={<RelationshipsLayout facade={facade} scope="decisions" />} path="/relationships/decisions" />
              <Route element={<RelationshipsLayout facade={facade} scope="governance" />} path="/relationships/governance" />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    );

    const nav = screen.getByRole("navigation", { name: "Relationship sections" });
    // 计数徽标与概览同源同口径：图谱=有关系事实的 Skill 数、冲突处理=待确认
    // 冲突数、治理=已建立关系边数。
    await waitFor(() => {
      expect(within(nav).getByTestId("relationships-nav-count-graph")).toHaveTextContent("2");
    });
    expect(within(nav).getByTestId("relationships-nav-count-decisions")).toHaveTextContent("1");
    expect(within(nav).getByTestId("relationships-nav-count-governance")).toHaveTextContent("5");
    expect(within(nav).getByRole("link", { name: "Conflict decisions" })).toHaveAttribute("aria-current", "page");
  });
});
