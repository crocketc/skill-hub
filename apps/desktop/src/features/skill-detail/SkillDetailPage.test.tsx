import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import {
  MemoryRouter,
  Route,
  useLocation,
  Routes,
  type InitialEntry,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import "../../styles/base.css";
import baseCss from "../../styles/base.css?raw";
import type { SkillDetailFacade } from "./api";
import type { MarkdownFacade } from "../markdown/api";
import { createMockMarkdownFacade } from "../markdown/testFixtures";
import { SkillDetailPage } from "./SkillDetailPage";
import { createMockSkillDetailFacade } from "./testFixtures";
import type { RemovalFacade } from "../removal/api";
import { skillLibraryKeys } from "../skills/api";

interface RenderDetailOptions {
  entry?: InitialEntry;
  facade?: SkillDetailFacade;
  markdownFacade?: MarkdownFacade;
  removalFacade?: RemovalFacade;
}

async function renderDetail({
  entry = "/library/skill-pdf",
  facade = createMockSkillDetailFacade(),
  markdownFacade = createMockMarkdownFacade(),
  removalFacade,
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
              element={<SkillDetailPage facade={facade} markdownFacade={markdownFacade} removalFacade={removalFacade} />}
              path="/library/:skillId"
            />
            <Route
              element={<SkillDetailPage facade={facade} markdownFacade={markdownFacade} removalFacade={removalFacade} />}
              path="/__preview/skill-detail/:skillId"
            />
            <Route element={<p>Library route</p>} path="/library" />
            <Route element={<ExportProbe />} path="/settings/data-protection" />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { client };
}

function ExportProbe() {
  const location = useLocation();
  const ids = (location.state as { exportSkillIds?: string[] } | null)?.exportSkillIds ?? [];
  return <p>export probe: {ids.join(",")}</p>;
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

  it("loads deletion impact and returns to the library after confirmation", async () => {
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        operationId: "op-delete",
        skillId: "skill-pdf",
        skillName: "PDF Reader",
        deployments: [],
        dependentProjects: [],
      }),
      commitDelete: vi.fn().mockResolvedValue({ centralSkillDeleted: true }),
    };
    const { client } = await renderDetail({ removalFacade });
    client.setQueryData(skillLibraryKeys.root, { cached: true });

    fireEvent.click(await screen.findByRole("button", { name: "Delete Skill" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));

    await waitFor(() => expect(removalFacade.commitDelete).toHaveBeenCalledWith("op-delete", {}));
    expect(client.getQueryState(skillLibraryKeys.root)?.isInvalidated).toBe(true);
    expect(await screen.findByText("Library route")).toBeVisible();
  });

  it("cancels deletion without committing a prepared operation", async () => {
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn(),
      commitUndeploy: vi.fn(),
      prepareDelete: vi.fn().mockResolvedValue({
        operationId: "op-delete",
        skillId: "skill-pdf",
        skillName: "PDF Reader",
        deployments: [],
        dependentProjects: [],
      }),
      commitDelete: vi.fn(),
    };
    await renderDetail({ removalFacade });

    fireEvent.click(await screen.findByRole("button", { name: "Delete Skill" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(removalFacade.commitDelete).not.toHaveBeenCalled();
  });

  it("prepares and commits a shared-target undeploy from the relations section", async () => {
    const removalFacade: RemovalFacade = {
      prepareUndeploy: vi.fn().mockResolvedValue({
        deploymentId: "relation-codex",
        label: "Codex CLI",
        operationId: "op-undeploy",
        sharedTarget: true,
      }),
      commitUndeploy: vi.fn().mockResolvedValue(undefined),
      prepareDelete: vi.fn(),
      commitDelete: vi.fn(),
    };
    await renderDetail({ removalFacade });

    fireEvent.click(await screen.findByRole("button", { name: "Undeploy Codex CLI" }));
    expect(await screen.findByRole("dialog", { name: "Undeploy from Codex CLI?" })).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Undeploy handling" }), {
      target: { value: "keep_shared_deployment" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm undeploy" }));

    await waitFor(() => expect(removalFacade.commitUndeploy).toHaveBeenCalledWith(
      "op-undeploy",
      "keep_shared_deployment",
    ));
    expect(screen.queryByRole("dialog", { name: "Undeploy from Codex CLI?" })).not.toBeInTheDocument();
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

  it("returns to the preview Skill library instead of the unavailable production route", async () => {
    await renderDetail({
      entry: {
        pathname: "/__preview/skill-detail/skill-pdf",
        search: "?q=pdf",
        state: {
          libraryReturn: {
            focusSkillId: "skill-pdf",
            scrollLeft: 0,
            scrollTop: 416,
          },
        },
      },
    });

    expect(await screen.findByRole("link", { name: "Back to Skill library" })).toHaveAttribute(
      "href",
      "/__preview/skill-library?q=pdf",
    );
    expect(screen.getByRole("link", { name: "Next Skill" })).toHaveAttribute(
      "href",
      "/__preview/skill-detail/skill-sheet?q=pdf",
    );
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

  it("updates the preview detail and keeps adjacent controls after navigation", async () => {
    await renderDetail({ entry: "/__preview/skill-detail/skill-pdf" });

    expect(await screen.findByRole("heading", { name: "PDF Reader" })).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "Next Skill" }));

    expect(await screen.findByRole("heading", { name: "Spreadsheet Reader" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Read spreadsheet data safely" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Previous Skill" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Next Skill" })).toBeDisabled();
  });

  it("renders adjacent controls as a compact horizontal navigation", async () => {
    await renderDetail({ entry: "/__preview/skill-detail/skill-pdf" });

    const navigation = await screen.findByRole("navigation", { name: "Skill navigation" });
    expect(navigation).toHaveClass("sh-skill-detail__adjacent");
    expect(navigation.querySelectorAll("a")).toHaveLength(2);
    expect(baseCss).toMatch(/\.sh-skill-detail__adjacent\s*\{[\s\S]*display:\s*flex/);
    expect(baseCss).toMatch(/\.sh-skill-detail__adjacent\s*\{[\s\S]*flex-direction:\s*row/);
  });

  it("places adjacent Skill controls at the bottom of the detail section rail", async () => {
    await renderDetail({ entry: "/__preview/skill-detail/skill-pdf" });

    const sections = await screen.findByRole("navigation", { name: "Detail sections" });
    const adjacent = await screen.findByRole("navigation", { name: "Skill navigation" });
    expect(sections.compareDocumentPosition(adjacent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(adjacent.parentElement).toBe(sections.parentElement);
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

  it("merges the status summary into the Overview section", async () => {
    await renderDetail();

    expect(await screen.findByRole("navigation", { name: "Detail sections" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      "#overview",
    );
    expect(screen.getByText("Basic check passed")).toBeVisible();
    expect(screen.getByText("2 deployments")).toBeVisible();
    expect(screen.getByRole("group", { name: "Skill status" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Skill status" })).not.toBeInTheDocument();
  });

  it("surfaces the same update review entry beside the overview version", async () => {
    await renderDetail({
      facade: createMockSkillDetailFacade({
        summary: { upgradeAvailable: true, upstreamVersion: "v2.5.0" },
      }),
    });

    expect(await screen.findByRole("heading", { name: "Upstream update available" })).toBeVisible();
    await waitFor(() => {
      expect(screen.getAllByText("Current v2.4.1 → upstream v2.5.0")).toHaveLength(2);
      expect(screen.getAllByRole("button", { name: "View update diff" })).toHaveLength(2);
    });
  });

  it("places identity before the content description in the detail navigation", async () => {
    await renderDetail();

    const navigation = await screen.findByRole("navigation", { name: "Detail sections" });
    expect(await within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Overview",
      "Identity and source",
      "Content description",
      "Relations",
      "Requirements",
      "Security checks",
      "Related Skills",
      "External changes",
      "Version history",
    ]);
  });

  it("keeps the detail rail fixed while the content column scrolls", async () => {
    await renderDetail();
    await screen.findByRole("navigation", { name: "Detail sections" });

    const rail = document.querySelector(".sh-skill-detail__rail");
    const content = document.querySelector(".sh-skill-detail__content");
    expect(rail).toBeInTheDocument();
    expect(rail).toContainElement(screen.getByRole("navigation", { name: "Detail sections" }));
    expect(rail?.querySelector(".sh-skill-detail__header")).toBeInTheDocument();
    expect(content).toBeInTheDocument();

    expect(baseCss).toMatch(/\.sh-skill-detail\s*\{[\s\S]*height:\s*100%/);
    expect(baseCss).toMatch(/\.sh-skill-detail__content\s*\{[\s\S]*overflow-y:\s*auto/);
    expect(baseCss).toMatch(/\.sh-skill-detail__content\s*\{[\s\S]*display:\s*flex/);
    expect(baseCss).toMatch(/\.sh-skill-detail__section\s*\{[\s\S]*flex:\s*0\s+0\s+auto/);
    expect(baseCss).toMatch(/grid-template-columns:\s*minmax\(10rem,\s*12rem\)\s+minmax\(0,\s*1fr\)/);
    expect(baseCss).toMatch(/\.sh-skill-detail__layout\s*\{[\s\S]*gap:\s*var\(--space-4\)/);
    expect(baseCss).toMatch(/\.sh-skill-detail__rail\s*\{[\s\S]*overflow-y:\s*hidden/);
    expect(baseCss).toMatch(/\.sh-skill-detail__rail\s*\{[\s\S]*height:\s*100%/);
    expect(baseCss).toMatch(/@media\s*\(max-width:\s*110rem\)[\s\S]*\.sh-skill-detail__rail\s*\{[\s\S]*overflow-y:\s*auto/);
    expect(baseCss).toMatch(/\.sh-skill-detail__rail\s*\{[\s\S]*display:\s*flex/);
    expect(baseCss).toMatch(/\.sh-skill-detail__adjacent\s*\{[\s\S]*margin-top:\s*auto/);
  });

  it("keeps the overview compact and gives the content column the remaining width", async () => {
    await renderDetail();
    await screen.findByRole("navigation", { name: "Detail sections" });

    expect(document.getElementById("overview")).toHaveClass("sh-skill-detail__section--overview");
    expect(baseCss).toMatch(/\.sh-skill-detail__section--overview\s*\{[\s\S]*gap:\s*var\(--space-2\)/);
    expect(baseCss).toMatch(/\.sh-skill-detail__section--overview\s*\{[\s\S]*padding:\s*var\(--space-4\)/);
    expect(baseCss).toMatch(/\.sh-skill-detail__rail \.sh-skill-detail__title-row h1\s*\{[\s\S]*font-size:/);
    expect(baseCss).toMatch(/grid-template-columns:\s*minmax\(10rem,\s*12rem\)\s+minmax\(0,\s*1fr\)/);
  });

  it("highlights the section selected from the detail navigation", async () => {
    await renderDetail();

    await screen.findByRole("navigation", { name: "Detail sections" });
    const metadataLink = screen.getByRole("link", { name: "Identity and source" });
    fireEvent.click(metadataLink);

    expect(metadataLink).toHaveAttribute("aria-current", "location");
  });

  it("restores the active section from a detail hash", async () => {
    await renderDetail({ entry: "/library/skill-pdf#versions" });

    await screen.findByRole("navigation", { name: "Detail sections" });
    expect(screen.getByRole("link", { name: "Version history" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("loads the description and editable metadata panel independently", async () => {
    await renderDetail();
    expect(await screen.findByText("Original description")).toBeVisible();
    expect(screen.getByText("模型译文")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit My purpose" })).toBeVisible();
  });

  it("shows invocation and declared runtime requirements in the detail page", async () => {
    await renderDetail();

    expect(await screen.findByText("pdf-reader <file>")).toBeVisible();
    expect(screen.getByText("Poppler")).toBeVisible();
    expect(screen.getByText("Executable used for PDF rendering")).toBeVisible();
  });

  it("keeps Markdown in Description and editable fields in Metadata", async () => {
    await renderDetail();

    const descriptionHeading = await screen.findByRole("heading", {
      name: "Content description",
    });
    const workspaceHeading = await screen.findByRole("heading", {
      name: "Markdown workspace",
    });
    const metadataSectionHeading = await screen.findByRole("heading", { name: "Identity and source" });
    const metadataHeading = await screen.findByRole("heading", { name: "Original source text" });

    expect(
      descriptionHeading.compareDocumentPosition(workspaceHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      metadataSectionHeading.compareDocumentPosition(workspaceHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      metadataSectionHeading.compareDocumentPosition(metadataHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Extract PDF tables safely" }),
    ).toBeVisible();
  });
});

it("exports the skill from the versions section with the skill id carried over", async () => {
  const user = userEvent.setup();
  await renderDetail({ entry: "/library/skill-pdf" });

  const exportBtn = await screen.findByRole("button", { name: /Export this skill/ });
  await user.click(exportBtn);
  expect(await screen.findByText("export probe: skill-pdf")).toBeVisible();
});
