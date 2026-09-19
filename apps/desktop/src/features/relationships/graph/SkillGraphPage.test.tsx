import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../../i18n";
import type {
  RelationshipCandidatesParams,
  RelationshipGraphParams,
  RelationshipsFacade,
  SkillRelationshipCandidate,
  SkillRelationshipGraphResult,
} from "../api";
import { pickNextCenter, SkillGraphPage } from "./SkillGraphPage";

const CANDIDATES: SkillRelationshipCandidate[] = [
  {
    skill_id: "pdf-reader",
    display_name: "PDF Reader",
    runtime_name: "pdf-reader",
    tags: ["pdf", "documents"],
    matched_alias: "reader",
    relationship_count: 3,
    relationship_revision: "r42",
    last_verified_at: "2026-09-01T08:00:00Z",
  },
  {
    skill_id: "doc-reader",
    display_name: "Doc Reader",
    runtime_name: "doc-reader",
    tags: ["documents"],
    matched_alias: "reader",
    relationship_count: 2,
    relationship_revision: "r41",
    last_verified_at: "2026-09-02T08:00:00Z",
  },
  {
    skill_id: "md-reader",
    display_name: "Markdown Reader",
    runtime_name: "md-reader",
    tags: ["markdown"],
    matched_alias: null,
    relationship_count: 1,
    relationship_revision: "r40",
    last_verified_at: null,
  },
];

function graphFor(skillId: string, revision = REVISIONS[skillId] ?? "r42"): SkillRelationshipGraphResult {
  return {
    center_skill_id: skillId,
    nodes: [
      {
        node_id: `n-center-${skillId}`,
        kind: "skill",
        skill_id: skillId,
        relation_id: null,
        provenance_id: null,
        conflict_id: null,
        agent_client_id: null,
        directory_node_id: null,
        path: null,
        role: null,
        profile_id: null,
        collapsed_kind: null,
        relationship: null,
        match_state: null,
        active: null,
        source: null,
        collapsed_count: 0,
        last_verified_at: "2026-09-01T08:00:00Z",
      },
      {
        node_id: `n-rel-${skillId}`,
        kind: "skill",
        skill_id: `${skillId}-notes`,
        relation_id: null,
        provenance_id: null,
        conflict_id: null,
        agent_client_id: null,
        directory_node_id: null,
        path: null,
        role: null,
        profile_id: null,
        collapsed_kind: null,
        relationship: null,
        match_state: null,
        active: null,
        source: null,
        collapsed_count: 0,
        last_verified_at: null,
      },
      {
        node_id: `n-agent-${skillId}`,
        kind: "agent",
        skill_id: null,
        relation_id: null,
        provenance_id: null,
        conflict_id: null,
        agent_client_id: "claude",
        directory_node_id: null,
        path: null,
        role: null,
        profile_id: null,
        collapsed_kind: null,
        relationship: null,
        match_state: null,
        active: null,
        source: null,
        collapsed_count: 0,
        last_verified_at: null,
      },
    ],
    edges: [
      {
        edge_id: `e-rel-${skillId}`,
        from_node_id: `n-center-${skillId}`,
        to_node_id: `n-rel-${skillId}`,
        kind: "related_skill",
        relationship: "managed_copy",
        relation_id: "rel-1",
        provenance_id: null,
        conflict_id: null,
        match_state: "content_verified",
        active: true,
        last_verified_at: "2026-09-01T08:00:00Z",
      },
      {
        edge_id: `e-agent-${skillId}`,
        from_node_id: `n-center-${skillId}`,
        to_node_id: `n-agent-${skillId}`,
        kind: "deployment",
        relationship: "managed_link",
        relation_id: "rel-2",
        provenance_id: null,
        conflict_id: null,
        match_state: null,
        active: true,
        last_verified_at: "2026-09-01T08:00:00Z",
      },
    ],
    fact_counts: { deployment_relations: 1, source_relations: 0, conflict_cases: 0 },
    collapsed_count: 0,
    relationship_revision: revision,
    last_verified_at: "2026-09-01T08:00:00Z",
  };
}

interface FacadeCalls {
  candidates: Array<RelationshipCandidatesParams>;
  graph: Array<RelationshipGraphParams>;
}

interface PageOptions {
  candidates?: SkillRelationshipCandidate[];
  failGraph?: boolean;
  /** 图谱结果携带的修订号（默认与候选一致；注入不同值可测试收敛路径）。 */
  graphRevision?: string;
  random?: () => number;
}

/** 与候选一致的修订号：正常路径一次图谱查询即可命中带修订的键。 */
const REVISIONS: Record<string, string> = {
  "pdf-reader": "r42",
  "doc-reader": "r41",
  "md-reader": "r40",
};

function createFacade(options: PageOptions = {}): { facade: RelationshipsFacade; calls: FacadeCalls } {
  const calls: FacadeCalls = { candidates: [], graph: [] };
  const candidates = options.candidates ?? CANDIDATES;
  const facade: RelationshipsFacade = {
    async listCandidates(params = {}) {
      calls.candidates.push(params);
      const text = params.text?.trim().toLowerCase() ?? "";
      const tags = params.tags ?? [];
      return candidates.filter((candidate) => {
        const matchesText = text.length === 0
          || candidate.display_name.toLowerCase().includes(text)
          || candidate.runtime_name.toLowerCase().includes(text)
          || (candidate.matched_alias?.toLowerCase().includes(text) ?? false);
        const matchesTags = tags.every((tag) => candidate.tags.includes(tag));
        return matchesText && matchesTags;
      });
    },
    async getGraph(params) {
      calls.graph.push(params);
      if (options.failGraph) {
        throw new Error("graph read failed");
      }
      return graphFor(params.skillId, options.graphRevision);
    },
    async getConflictWorkspace() {
      throw new Error("not used by the graph page");
    },
    async listGovernance() {
      throw new Error("not used by the graph page");
    },
  };
  return { facade, calls };
}

function LocationProbe({ locations }: { locations: Array<{ search: string; type: string }> }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current && navigationType === "POP" && locations.length === 0) {
      mounted.current = true;
    }
    locations.push({ search: location.search, type: navigationType });
  }, [location, navigationType, locations]);
  return (
    <button onClick={() => navigate(-1)} type="button">
      test-back
    </button>
  );
}

async function renderPage(url: string, options: PageOptions = {}) {
  const { facade, calls } = createFacade(options);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = await createSkillHubI18n(["en-US"]);
  const locations: Array<{ search: string; type: string }> = [];
  const tree = (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[url]}>
          <LocationProbe locations={locations} />
          <SkillGraphPage facade={facade} random={options.random} />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>
  );
  const view = render(tree);
  return { calls, client, locations, tree, view };
}

describe("first-load center selection", () => {
  it("picks the center once from candidates and replaces the URL", async () => {
    const random = vi.fn(() => 0);
    const { calls, locations } = await renderPage("/relationships", { random });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    });
    await waitFor(() => {
      expect(calls.graph.map((params) => params.skillId)).toEqual(["pdf-reader"]);
    });

    // 只随机一次：候选查询一次，URL 以 replace 收敛到选中的 skillId。
    expect(calls.candidates).toHaveLength(1);
    expect(random).toHaveBeenCalledTimes(1);
    expect(locations.at(-1)?.search).toBe("?skillId=pdf-reader");
    expect(locations.at(-1)?.type).toBe("REPLACE");
    expect(locations.some((entry) => entry.type === "PUSH")).toBe(false);
  });

  it("does not re-randomize on refresh, deep link or re-render when skillId is present", async () => {
    const random = vi.fn(() => 0);
    const { calls, tree, view } = await renderPage("/relationships?skillId=doc-reader", {
      random,
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Doc Reader" })).toBeVisible();
    });

    // 深链按 URL 直接定中心：随机源从不被调用，URL 不发生任何导航（连 replace 都没有）。
    expect(random).not.toHaveBeenCalled();
    expect(calls.candidates).toEqual([{ text: "", tags: [] }]);
    expect(calls.graph.map((params) => params.skillId)).toEqual(["doc-reader"]);

    view.rerender(tree);
    await waitFor(() => {
      expect(calls.graph).toHaveLength(1);
    });
  });

  it("keeps the previous center reachable with browser back after 换一个 Skill", async () => {
    const user = userEvent.setup();
    const { locations } = await renderPage("/relationships?skillId=pdf-reader", {
      random: vi.fn(() => 0),
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "Pick another Skill" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Doc Reader" })).toBeVisible();
    });
    expect(locations.at(-1)?.search).toBe("?skillId=doc-reader");
    expect(locations.at(-1)?.type).toBe("PUSH");

    await user.click(screen.getByRole("button", { name: "test-back" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    });
    expect(locations.at(-1)?.search).toBe("?skillId=pdf-reader");
  });
});

describe("pickNextCenter", () => {
  const list = CANDIDATES;

  it("never returns the current center", () => {
    for (const candidate of list) {
      const picked = pickNextCenter(list, candidate.skill_id, () => 0);
      expect(picked?.skill_id).not.toBe(candidate.skill_id);
    }
  });

  it("skips candidates without displayable relationships", () => {
    const withEmpty = [
      ...list,
      { ...list[2]!, skill_id: "empty-skill", relationship_count: 0 },
    ];
    // 指向“空候选”的随机数必须被跳过：非空候选才有资格成为中心。
    const picked = pickNextCenter(withEmpty, "pdf-reader", () => 0.99);
    expect(picked?.skill_id).toBe("md-reader");
  });

  it("returns null when no non-empty candidate remains", () => {
    const single = [list[0]!];
    expect(pickNextCenter(single, "pdf-reader", () => 0)).toBeNull();
  });
});

describe("zero candidates", () => {
  it("shows the discovery CTA and never renders an empty canvas", async () => {
    const { calls } = await renderPage("/relationships", { candidates: [] });

    const cta = await screen.findByRole("link", { name: "Open discovery" });
    expect(cta).toBeVisible();
    expect(cta).toHaveAttribute("href", "/discovery?from=relationships");
    expect(screen.queryByTestId("skill-graph-canvas")).not.toBeInTheDocument();
    expect(calls.graph).toHaveLength(0);
  });
});

describe("alias search", () => {
  it("presents a choice when several skills match the alias", async () => {
    const user = userEvent.setup();
    const { calls } = await renderPage("/relationships?skillId=pdf-reader");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    });

    await user.type(screen.getByLabelText("Search by name or alias"), "reader");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Multiple Skills match — choose one.")).toBeVisible();
    // 搜索结果限定在结果列表内：画布节点标签同样可读（DEV-15），不做全局匹配。
    const resultsList = document.querySelector(".sh-graph-search__results ul") as HTMLElement;
    expect(within(resultsList).getByRole("button", { name: /PDF Reader/ })).toBeVisible();
    expect(within(resultsList).getByRole("button", { name: /Doc Reader/ })).toBeVisible();
    expect(calls.candidates.at(-1)).toEqual({ text: "reader", tags: [] });

    await user.click(within(resultsList).getByRole("button", { name: /Doc Reader/ }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Doc Reader" })).toBeVisible();
    });
  });

  it("goes directly when the search has exactly one result and reports misses", async () => {
    const user = userEvent.setup();
    const { calls } = await renderPage("/relationships?skillId=pdf-reader");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    });

    await user.type(screen.getByLabelText("Search by name or alias"), "markdown");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Markdown Reader" })).toBeVisible();
    });
    expect(calls.candidates.at(-1)).toEqual({ text: "markdown", tags: [] });

    await user.type(screen.getByLabelText("Search by name or alias"), "zzz");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No matching Skill.")).toBeVisible();
  });
});

describe("tags and query facts", () => {
  it("limits center candidates by tags without ever sending tags to the graph query", async () => {
    const user = userEvent.setup();
    const { calls } = await renderPage("/relationships?skillId=pdf-reader&tags=documents");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "Pick another Skill" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Doc Reader" })).toBeVisible();
    });
    // 候选查询带标签；图谱查询事实里没有 tags。
    expect(calls.candidates.at(-1)).toEqual({ text: "", tags: ["documents"] });
    const lastGraph = calls.graph.at(-1);
    expect(lastGraph?.skillId).toBe("doc-reader");
    expect(JSON.stringify(lastGraph)).not.toContain("tags");
  });

  it("uses tags for the first random pick from candidates", async () => {
    const { calls } = await renderPage("/relationships?tags=documents", {
      random: vi.fn(() => 0.9),
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Doc Reader" })).toBeVisible();
    });
    expect(calls.candidates[0]).toEqual({ text: "", tags: ["documents"] });
    expect(calls.graph[0]?.skillId).toBe("doc-reader");
  });

  it("carries skillId, explicit empty filters and relationship_revision in the graph query key", async () => {
    const { client } = await renderPage("/relationships?skillId=pdf-reader");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    });

    const graphKeys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey)
      .filter((key) => key[1] === "graph");
    expect(graphKeys.length).toBeGreaterThan(0);
    const params = graphKeys.at(-1)?.[2] as Record<string, unknown>;
    expect(params).toMatchObject({
      skillId: "pdf-reader",
      relationshipTypes: [],
      statuses: [],
      relationshipRevision: "r42",
    });
  });
});

describe("relationship_revision convergence", () => {
  it("refetches once under a revisioned key when facts moved past the candidate snapshot", async () => {
    const { calls } = await renderPage("/relationships?skillId=doc-reader", {
      graphRevision: "r99",
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Doc Reader" })).toBeVisible();
    });
    await waitFor(() => {
      expect(calls.graph.at(-1)?.relationshipRevision).toBe("r99");
    });
    // 首查带候选修订，收敛查询带最新修订；随后稳定，不再增长。
    expect(calls.graph).toHaveLength(2);
    expect(calls.graph[0]?.relationshipRevision).toBe("r41");
    expect(screen.getByRole("heading", { name: "Doc Reader" })).toBeVisible();
  });
});

describe("fact filters", () => {
  it("moves filter state into the URL and the graph query without changing reported facts", async () => {
    const user = userEvent.setup();
    const { calls } = await renderPage("/relationships?skillId=pdf-reader");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    });
    // 事实计数来自查询结果本身，与筛选无关。
    expect(screen.getByText("Deployment relations 1, sources 0, conflicts 0")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("checkbox", { name: "Content verified" }));

    await waitFor(() => {
      expect(calls.graph.at(-1)?.statuses).toEqual(["content_verified"]);
    });
    expect(screen.getByText("Deployment relations 1, sources 0, conflicts 0")).toBeVisible();
    // 图谱查询仍然只带事实筛选，不带 tags。
    expect(JSON.stringify(calls.graph.at(-1))).not.toContain("tags");
  });
});

describe("jumps and return state", () => {
  it("carries from=relationships on outbound jumps and saves the return state", async () => {
    const { view } = await renderPage("/relationships?skillId=pdf-reader");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
    });

    const viewSkill = screen.getByRole("link", { name: "View Skill" });
    expect(viewSkill).toHaveAttribute("href", "/library/pdf-reader?from=relationships");
    expect(screen.getByRole("link", { name: "Open relationship governance" })).toHaveAttribute(
      "href",
      "/relationships/governance?from=graph",
    );

    // 点击跳转前保存返回状态（视口），供浏览器后退恢复。
    fireEvent.click(viewSkill, { button: 0 });
    const keys = Object.keys(window.sessionStorage);
    expect(keys.some((key) => key.startsWith("skillhub:relationships:return-state:graph:"))).toBe(
      true,
    );
    expect(view.container).toBeInstanceOf(HTMLElement);
  });

  it("shows an honest error state when the graph query fails", async () => {
    await renderPage("/relationships?skillId=pdf-reader", { failGraph: true });

    expect(await screen.findByText("The graph failed to load.")).toBeVisible();
  });
});
