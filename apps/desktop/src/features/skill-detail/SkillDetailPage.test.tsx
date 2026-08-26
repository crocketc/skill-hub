import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import {
  MemoryRouter,
  Route,
  Routes,
  type InitialEntry,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { SkillDetailFacade } from "./api";
import { SkillDetailPage } from "./SkillDetailPage";
import { createMockSkillDetailFacade } from "./testFixtures";

interface RenderDetailOptions {
  entry?: InitialEntry;
  facade?: SkillDetailFacade;
}

async function renderDetail({
  entry = "/library/skill-pdf",
  facade = createMockSkillDetailFacade(),
}: RenderDetailOptions = {}) {
  const i18n = await createSkillHubI18n(["en-US"]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route
              element={<SkillDetailPage facade={facade} />}
              path="/library/:skillId"
            />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { client };
}

describe("SkillDetailPage shell", () => {
  beforeEach(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: class {
        disconnect() {}
        observe() {}
        unobserve() {}
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns to the filtered Skill library with its scroll and focus context", async () => {
    await renderDetail({
      entry: {
        pathname: "/library/skill-pdf",
        search: "?q=pdf&sort=version:desc",
        state: {
          libraryReturn: {
            focusSkillId: "skill-pdf",
            scrollLeft: 0,
            scrollTop: 416,
          },
        },
      },
    });

    const back = await screen.findByRole("link", {
      name: "Back to Skill library",
    });
    expect(back).toHaveAttribute(
      "href",
      "/library?q=pdf&sort=version%3Adesc",
    );
    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
  });

  it("omits fabricated previous and next controls on direct entry", async () => {
    await renderDetail({
      facade: createMockSkillDetailFacade({ adjacent: null }),
    });

    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Previous Skill" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Next Skill" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the library query when navigating to an adjacent Skill", async () => {
    await renderDetail({ entry: "/library/skill-pdf?q=pdf&sort=version:desc" });

    expect(await screen.findByRole("link", { name: "Previous Skill" })).toHaveAttribute(
      "href",
      "/library/skill-doc?q=pdf&sort=version%3Adesc",
    );
    expect(screen.getByRole("link", { name: "Next Skill" })).toHaveAttribute(
      "href",
      "/library/skill-sheet?q=pdf&sort=version%3Adesc",
    );
  });

  it("recovers from a summary failure without leaving the detail route", async () => {
    await renderDetail({
      facade: createMockSkillDetailFacade({ failSummaryOnce: true }),
    });

    expect(await screen.findByText("Unable to load Skill details")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
  });

  it("shows an explicit empty state when the Skill no longer exists", async () => {
    await renderDetail({
      facade: createMockSkillDetailFacade({ missingSkill: true }),
    });

    expect(await screen.findByText("This Skill is not in the local library")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("renders the approved section navigation and status rail from summary facts", async () => {
    await renderDetail();

    expect(await screen.findByRole("navigation", { name: "Detail sections" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      "#overview",
    );
    expect(screen.getByText("Basic check passed")).toBeVisible();
    expect(screen.getByText("2 deployments")).toBeVisible();
  });

  it("loads the description and editable metadata panel independently", async () => {
    await renderDetail();
    expect(await screen.findByText("Original description")).toBeVisible();
    expect(screen.getByText("模型译文")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit My purpose" })).toBeVisible();
  });
});
