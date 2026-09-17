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
import "./skill-detail.css";
import baseCss from "../../styles/base.css?raw";
import type { SkillDetailFacade } from "./api";
import type { MarkdownFacade } from "../markdown/api";
import { createMockMarkdownFacade } from "../markdown/testFixtures";
import { SkillDetailPage } from "./SkillDetailPage";
import { createMockSkillDetailFacade } from "./testFixtures";
import type { RemovalFacade } from "../removal/api";
import { skillLibraryKeys } from "../skills/api";
import { createOperationTracker, type OperationTracker } from "../../platform/operationTracker";

interface RenderDetailOptions {
  entry?: InitialEntry;
  facade?: SkillDetailFacade;
  locale?: "en-US" | "zh-CN";
  markdownFacade?: MarkdownFacade;
  removalFacade?: RemovalFacade;
  tracker?: OperationTracker;
}

async function renderDetail({
  entry = "/library/skill-pdf",
  facade = createMockSkillDetailFacade(),
  locale = "en-US",
  markdownFacade = createMockMarkdownFacade(),
  removalFacade,
  tracker,
}: RenderDetailOptions = {}) {
  const i18n = await createSkillHubI18n([locale]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route
              element={<SkillDetailPage facade={facade} markdownFacade={markdownFacade} removalFacade={removalFacade} tracker={tracker} />}
              path="/library/:skillId"
            />
            <Route
              element={<SkillDetailPage facade={facade} markdownFacade={markdownFacade} removalFacade={removalFacade} tracker={tracker} />}
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
    const tracker = createOperationTracker();
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
    const { client } = await renderDetail({ removalFacade, tracker });
    client.setQueryData(skillLibraryKeys.root, { cached: true });

    fireEvent.click(await screen.findByRole("button", { name: "Delete from library" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm deletion from library" }));

    await waitFor(() => expect(removalFacade.commitDelete).toHaveBeenCalledWith("op-delete", {}));
    expect(tracker.getSnapshot()).toEqual([
      expect.objectContaining({ operationId: "op-delete", status: "success" }),
    ]);
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

    fireEvent.click(await screen.findByRole("button", { name: "Delete from library" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(removalFacade.commitDelete).not.toHaveBeenCalled();
  });

  it("names the destructive entries after their own removal objects in Chinese", async () => {
    await renderDetail({ locale: "zh-CN" });

    // P1-15：入口名与移除对象一一对应——详情页删除按钮指向“删除库中 Skill”，
    // 关系区逐条入口指向“从目标移除”，不复用笼统的“移除”。
    expect(await screen.findByRole("button", { name: "从库中删除 Skill" })).toBeVisible();
    expect(await screen.findByRole("button", { name: "从 Codex CLI 移除" })).toBeVisible();
  });

  it("prepares and commits a shared-target undeploy from the relations section", async () => {
    const tracker = createOperationTracker();
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
    await renderDetail({ removalFacade, tracker });

    fireEvent.click(await screen.findByRole("button", { name: "Remove from Codex CLI" }));
    expect(await screen.findByRole("dialog", { name: "Remove from Codex CLI?" })).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Removal handling" }), {
      target: { value: "keep_shared_deployment" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal from target" }));

    await waitFor(() => expect(removalFacade.commitUndeploy).toHaveBeenCalledWith(
      "op-undeploy",
      "keep_shared_deployment",
    ));
    expect(tracker.getSnapshot()).toEqual([
      expect.objectContaining({ operationId: "op-undeploy", status: "success" }),
    ]);
    expect(screen.queryByRole("dialog", { name: "Remove from Codex CLI?" })).not.toBeInTheDocument();
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

  it("merges the status summary into the overview block of the status zone", async () => {
    await renderDetail();

    expect(await screen.findByRole("navigation", { name: "Detail sections" })).toBeVisible();
    expect(document.getElementById("overview")?.closest("section")?.id).toBe("zone-status");
    expect(screen.getByText("Basic check passed")).toBeVisible();
    expect(screen.getAllByText("2")).toHaveLength(2);
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

  it("exposes the five information zones in the detail navigation", async () => {
    await renderDetail();

    const navigation = await screen.findByRole("navigation", { name: "Detail sections" });
    expect(await within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Identity",
      "Status",
      "Content",
      "Relations",
      "Lifecycle",
    ]);
  });

  it("keeps every legacy section anchor reachable inside its zone", async () => {
    await renderDetail();
    await screen.findByRole("heading", { name: "PDF Reader" });

    const zoneOf = (anchorId: string) =>
      document.getElementById(anchorId)?.closest("section")?.id;
    expect(zoneOf("metadata")).toBe("zone-identity");
    expect(zoneOf("overview")).toBe("zone-status");
    expect(zoneOf("security")).toBe("zone-status");
    expect(zoneOf("description")).toBe("zone-content");
    expect(zoneOf("relations")).toBe("zone-relations");
    expect(zoneOf("requirements")).toBe("zone-relations");
    expect(zoneOf("connections")).toBe("zone-relations");
    expect(zoneOf("versions")).toBe("zone-lifecycle");
    expect(zoneOf("external")).toBe("zone-lifecycle");
  });

  it("renders the identity header in the content column ahead of the identity zone", async () => {
    await renderDetail();
    const header = await screen.findByRole("heading", { name: "PDF Reader" });
    const identityZone = screen
      .getByRole("heading", { name: "Identity" })
      .closest("section");
    expect(identityZone).not.toBeNull();

    // 头部与身份分区共享同一内容列容器，且头部位于分区之前。
    const contentColumn = identityZone?.parentElement;
    expect(contentColumn?.contains(header)).toBe(true);
    expect(
      header.compareDocumentPosition(identityZone as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      contentColumn?.contains(screen.getByRole("button", { name: "Delete from library" })),
    ).toBe(true);
  });

  it("activates the containing zone for a legacy section hash", async () => {
    await renderDetail({ entry: "/library/skill-pdf#versions" });

    await screen.findByRole("navigation", { name: "Detail sections" });
    expect(screen.getByRole("link", { name: "Lifecycle" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("summarizes the source, library, and deployment trajectory in the relations zone", async () => {
    await renderDetail();
    await screen.findByRole("heading", { name: "PDF Reader" });

    const trajectory = screen.getByRole("group", {
      name: "Source, library, and addition targets",
    });
    expect(trajectory).toBeVisible();
    expect(within(trajectory).getByText("github:example/pdf-reader")).toBeVisible();
    expect(within(trajectory).getByText("2")).toBeVisible();
  });

  it("keeps the detail rail fixed while the content column scrolls", async () => {
    await renderDetail();
    await screen.findByRole("navigation", { name: "Detail sections" });

    const rail = document.querySelector(".sh-skill-detail__rail");
    const content = document.querySelector(".sh-skill-detail__content");
    expect(rail).toBeInTheDocument();
    expect(rail).toContainElement(screen.getByRole("navigation", { name: "Detail sections" }));
    expect(content).toContainElement(document.querySelector(".sh-skill-detail__header"));
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

  it("gives the content column the remaining width beside the fixed rail", async () => {
    await renderDetail();
    await screen.findByRole("navigation", { name: "Detail sections" });

    expect(document.getElementById("overview")?.closest("section")).toHaveClass(
      "sh-skill-detail__zone",
    );
    expect(baseCss).toMatch(/grid-template-columns:\s*minmax\(10rem,\s*12rem\)\s+minmax\(0,\s*1fr\)/);
  });

  it("highlights the zone selected from the detail navigation", async () => {
    await renderDetail();

    await screen.findByRole("navigation", { name: "Detail sections" });
    const identityLink = screen.getByRole("link", { name: "Identity" });
    fireEvent.click(identityLink);

    expect(identityLink).toHaveAttribute("aria-current", "location");
  });

  it("restores the active zone from a detail hash", async () => {
    await renderDetail({ entry: "/library/skill-pdf#versions" });

    await screen.findByRole("navigation", { name: "Detail sections" });
    expect(screen.getByRole("link", { name: "Lifecycle" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("loads the description and editable metadata panel independently", async () => {
    await renderDetail();
    // P1-12：原文与译文收纳为次级展示，展开后才可见。
    fireEvent.click(await screen.findByText("Original text and translation"));
    expect(screen.getByText("Original description")).toBeVisible();
    expect(screen.getByText("模型译文")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit My purpose" })).toBeVisible();
  });

  it("states the skill purpose exactly once in the overview block and never in the header", async () => {
    await renderDetail({
      facade: createMockSkillDetailFacade({
        // getSummary 口径（译文回退链）与元数据用户用途刻意不同，便于统计出现次数。
        summary: { purpose: "Summarized purpose from getSummary" },
      }),
    });

    const purposes = await screen.findAllByText("Summarized purpose from getSummary");
    expect(purposes).toHaveLength(1);
    expect(document.getElementById("overview")?.contains(purposes[0])).toBe(true);
    const header = document.querySelector(".sh-skill-detail__header");
    expect(header?.contains(purposes[0])).toBe(false);
  });

  it("shows the alias once in the header and keeps alias editing in the metadata", async () => {
    await renderDetail();

    // 别名只在头部展示一次；元数据保留编辑契约但不再重复只读展示同一值。
    expect(await screen.findAllByText("PDF 表格读取器")).toHaveLength(1);
    const header = document.querySelector(".sh-skill-detail__header");
    expect(header?.textContent).toContain("PDF 表格读取器");
    expect(screen.getByRole("button", { name: "Edit Alias" })).toBeVisible();
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
    // P1-12：原文文本折叠为次级展示，展开后标题可见。
    fireEvent.click(screen.getByText("Original text and translation"));
    const metadataHeading = screen.getByRole("heading", { name: "Original source text" });

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

describe("Task 7: governed relationship sections", () => {
  const overview = {
    scope: { type: "skill" as const, value: { skill_id: "skill-pdf" } },
    directory_nodes: [],
    agent_directory_capabilities: [],
    source_relations: [
      {
        provenance_id: "prov-1",
        skill_id: "skill-pdf",
        directory_node_id: "node-native",
        agent_client_id: "codex-cli",
        source_path: "C:/Users/demo/.codex/skills/pdf-reader",
        source_path_key: "pk-pdf",
        relationship: "import_copy" as const,
        file_representation: "directory" as const,
        ownership: "observed_unmanaged" as const,
        link_target_path: null,
        link_target_directory_id: null,
        content_fingerprint: "sha256:aa",
        source: { kind: "local" as const, locator: { local_path: "C:/Users/demo/.codex/skills/pdf-reader" } },
        imported_at: "2026-09-15T00:00:00Z",
      },
    ],
    deployment_relations: [
      {
        relation_id: "rel-copy",
        skill_id: "skill-pdf",
        agent_client_id: "codex-cli",
        path: "C:/Users/demo/.codex/skills/pdf-reader",
        path_key: "pk-pdf",
        directory_node_id: "node-native",
        relationship: "managed_copy" as const,
        file_representation: "copy" as const,
        ownership: "skillhub_managed" as const,
        link_target_path: null,
        link_target_path_key: null,
        link_target_directory_id: null,
        content_fingerprint: "sha256:aa",
        origin: "import" as const,
        match_state: "content_verified" as const,
        active: true,
        observed_at: "2026-09-15T00:00:00Z",
        released_at: null,
      },
    ],
    conflict_cases: [],
    pending_governance_tasks: [],
    agent_execution_confirmed: false,
  };

  it("renders multi-source provenance and governed deployment relations on the page", async () => {
    await renderDetail({
      facade: createMockSkillDetailFacade({ relationshipOverview: overview }),
      locale: "zh-CN",
    });

    expect(await screen.findByText("多来源存证")).toBeVisible();
    expect(screen.getByText("C:/Users/demo/.codex/skills/pdf-reader")).toBeVisible();
    expect(screen.getByText("关系类型与移除影响")).toBeVisible();
    expect(screen.getByTestId("governed-relation")).toBeVisible();
    expect(screen.getByText("复制部署")).toBeVisible();
    // 每个活动关系都有移除影响入口（本页不执行变更）。
    expect(screen.getAllByRole("button", { name: "查看移除影响" }).length).toBeGreaterThanOrEqual(1);
  });

  it("degrades honestly when the relationship overview is unavailable", async () => {
    await renderDetail({
      facade: {
        ...createMockSkillDetailFacade(),
        getRelationshipOverview: async () => {
          throw new Error("overview unavailable");
        },
      },
      locale: "zh-CN",
    });

    expect(await screen.findByText("关系事实暂不可用；部署与来源信息可能不完整。")).toBeVisible();
    // 既有部署关系行与从目标移除入口不受影响，页面没有虚假的空事实声明。
    expect(screen.getAllByTestId("physical-target").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("governed-relations")).not.toBeInTheDocument();
  });
});
