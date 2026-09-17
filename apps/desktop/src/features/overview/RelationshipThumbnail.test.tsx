import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type {
  ConflictWorkspace,
  RelationGovernanceLedger,
  SkillRelationshipCandidate,
} from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import type { RelationshipsFacade } from "../relationships/api";
import { RelationshipThumbnailNetwork } from "./RelationshipThumbnail";

function conflictCase(conflictId: string) {
  return {
    case: {
      classification: "uncertain" as const,
      conflict_id: conflictId,
      evidence: { fingerprints_match: null, names_match: true, sufficient_identity_evidence: false },
      member_skill_ids: [],
    },
    latest_analysis: null,
    analysis_stale: false,
    recommended_decision: null,
  };
}

/** 任务 2 冻结投影形状：cases=待确认全集，handled 是历史、绝不能回流计数。 */
const populatedWorkspace: ConflictWorkspace = {
  cases: [conflictCase("conflict-1"), conflictCase("conflict-2")],
  handled_count: 1,
  handled: [
    {
      conflict_id: "conflict-0",
      decision: "keep_distinct",
      conclusion: "distinct_skill",
      decided_at: "2026-09-01T00:00:00Z",
    },
  ],
  relationship_revision: "7",
  last_verified_at: null,
};

const populatedCandidates: SkillRelationshipCandidate[] = [
  {
    display_name: "Writer",
    last_verified_at: null,
    matched_alias: null,
    relationship_count: 2,
    relationship_revision: "7",
    runtime_name: "writer",
    skill_id: "skill-writer" as SkillRelationshipCandidate["skill_id"],
    tags: [],
  },
  {
    display_name: "Reader",
    last_verified_at: null,
    matched_alias: null,
    relationship_count: 1,
    relationship_revision: "7",
    runtime_name: "reader",
    skill_id: "skill-reader" as SkillRelationshipCandidate["skill_id"],
    tags: [],
  },
];

const populatedLedger: RelationGovernanceLedger = {
  bucket: "all",
  counts: { all: 7, blocked: 1, eligible_to_centralize: 4, needs_validation: 2 },
  last_verified_at: null,
  relationship_revision: "7",
  rows: [],
  total: 7,
};

/** 有关系事实的确定性门面：图 2 / 冲突 2（另有 1 条历史）/ 治理 7。 */
const populatedFacade: RelationshipsFacade = {
  async listCandidates() {
    return populatedCandidates;
  },
  async getGraph() {
    throw new Error("the overview never renders a full graph");
  },
  async getConflictWorkspace() {
    return populatedWorkspace;
  },
  async listGovernance() {
    return populatedLedger;
  },
};

/** 零关系事实门面：三个来源全空但查询成功（真实空态，不是失败）。 */
const emptyFacade: RelationshipsFacade = {
  async listCandidates() {
    return [];
  },
  async getGraph() {
    throw new Error("the overview never renders a full graph");
  },
  async getConflictWorkspace() {
    return { ...populatedWorkspace, cases: [], handled: [], handled_count: 0 };
  },
  async listGovernance() {
    return {
      ...populatedLedger,
      rows: [],
      total: 0,
      counts: { all: 0, blocked: 0, eligible_to_centralize: 0, needs_validation: 0 },
    };
  },
};

/** 永不结算的门面：模拟慢查询，锁定加载中的诚实占位。 */
const pendingFacade: RelationshipsFacade = {
  listCandidates() {
    return new Promise(() => undefined);
  },
  async getGraph() {
    throw new Error("the overview never renders a full graph");
  },
  getConflictWorkspace() {
    return new Promise(() => undefined);
  },
  listGovernance() {
    return new Promise(() => undefined);
  },
};

/** 三个查询全部失败的门面：概览其余内容必须照常，关系带给出诚实提示。 */
const failingFacade: RelationshipsFacade = {
  async listCandidates() {
    throw new Error("ipc unavailable");
  },
  async getGraph() {
    throw new Error("the overview never renders a full graph");
  },
  async getConflictWorkspace() {
    throw new Error("ipc unavailable");
  },
  async listGovernance() {
    throw new Error("ipc unavailable");
  },
};

async function renderNetwork(facade: RelationshipsFacade) {
  const i18n = await createSkillHubI18n(["en-US"]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<RelationshipThumbnailNetwork facade={facade} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

it("renders the three entries with counts taken from the frozen api aggregation", async () => {
  await renderNetwork(populatedFacade);

  // 每个入口的可访问名称由 api 层计数构造；冲突数=投影 cases（2 条），
  // handled 历史（1 条）绝不回流 —— 组件若自行重算就会显示 3。
  expect(
    await screen.findByRole("link", {
      name: "Open relationship graph (2 skills with displayable relations)",
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open conflict workspace (2 unconfirmed conflicts)" }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open relationship governance (7 relation edges)" }),
  ).toBeVisible();

  // 视觉结构沿用概览统计的两行卡：数字 + 入口名。
  const graphLink = screen.getByRole("link", {
    name: "Open relationship graph (2 skills with displayable relations)",
  });
  expect(within(graphLink).getByText("2", { exact: true })).toBeVisible();
  expect(within(graphLink).getByText("Relationship graph")).toBeVisible();
});

it("deep-links each entry to its frozen relationship subpage route", async () => {
  await renderNetwork(populatedFacade);

  expect(
    await screen.findByRole("link", {
      name: "Open relationship graph (2 skills with displayable relations)",
    }),
  ).toHaveAttribute("href", "/relationships");
  expect(
    screen.getByRole("link", { name: "Open conflict workspace (2 unconfirmed conflicts)" }),
  ).toHaveAttribute("href", "/relationships/decisions");
  expect(
    screen.getByRole("link", { name: "Open relationship governance (7 relation edges)" }),
  ).toHaveAttribute("href", "/relationships/governance");
});

it("keeps every entry navigable when all relationship counts are zero", async () => {
  await renderNetwork(emptyFacade);

  // 空态不吞没入口：三个 0 计数入口仍在，并给出中性说明而不是隐藏区域。
  expect(
    await screen.findByRole("link", {
      name: "Open relationship graph (0 skills with displayable relations)",
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open conflict workspace (0 unconfirmed conflicts)" }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open relationship governance (0 relation edges)" }),
  ).toBeVisible();
  expect(screen.getByText("No relationship facts to display yet.")).toBeVisible();
});

it("withholds counts behind honest placeholders while the summaries load", async () => {
  await renderNetwork(pendingFacade);

  // 加载中不显示假的 0：三个入口都以占位符呈现且不可点击跳转。
  const placeholders = await screen.findAllByText("–");
  expect(placeholders).toHaveLength(3);
  expect(screen.queryByRole("link", { name: /relationship graph/i })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Skill relationships" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
});

it("explains when all relationship summaries are unavailable", async () => {
  await renderNetwork(failingFacade);

  expect(
    await screen.findByText("Relationship overview is temporarily unavailable."),
  ).toBeVisible();
  // 失败不回退成 0 计数假象。
  expect(screen.queryByRole("link", { name: /unconfirmed conflicts/i })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Skill relationships" })).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
});

it("marks the conflict entry with a warning tone only when unconfirmed conflicts exist", async () => {
  const populated = await renderNetwork(populatedFacade);
  // 等关系查询落地后再断言类名（同步查询时入口还是占位符）。
  expect(
    await populated.findByRole("link", {
      name: "Open conflict workspace (2 unconfirmed conflicts)",
    }),
  ).toHaveClass("sh-overview__relation--alert");
  expect(
    populated.getByRole("link", {
      name: "Open relationship graph (2 skills with displayable relations)",
    }),
  ).not.toHaveClass("sh-overview__relation--alert");

  const empty = await renderNetwork(emptyFacade);
  expect(
    await empty.findByRole("link", { name: "Open conflict workspace (0 unconfirmed conflicts)" }),
  ).not.toHaveClass("sh-overview__relation--alert");
});
