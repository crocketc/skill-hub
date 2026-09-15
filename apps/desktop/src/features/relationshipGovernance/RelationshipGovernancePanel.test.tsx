import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { RelationshipGovernancePanel } from "./RelationshipGovernancePanel";
import type { ImportGovernanceGroup } from "./relationshipGovernance";
import type { ConflictAnalysis, ConflictCaseFact } from "../../api/bindings";

const groups: ImportGovernanceGroup[] = [
  {
    group_id: "shared-directory-read",
    classification: "shared_directory_read",
    default_action: "preserve_original",
    available_actions: ["preserve_original", "create_todo"],
    members: [
      {
        member_id: "pdf",
        display_name: "PDF",
        source_path: "/home/user/.agents/skills/pdf",
        affected_agents: ["trae.code", "zcode.shared"],
      },
      {
        member_id: "notes",
        display_name: "Notes",
        source_path: "/home/user/.agents/skills/notes",
        affected_agents: [],
      },
    ],
  },
  {
    group_id: "same-name-different-content",
    classification: "same_name_different_content",
    default_action: "create_todo",
    available_actions: ["preserve_original", "create_todo"],
    members: [
      {
        member_id: "reader",
        display_name: "Reader",
        source_path: "/home/user/.trae/skills/reader",
        affected_agents: ["trae.code"],
      },
    ],
  },
];

async function renderPanel(props: ComponentProps<typeof RelationshipGovernancePanel>) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <RelationshipGovernancePanel {...props} />
    </I18nextProvider>,
  );
}

it("renders structured impact facts per group without backend prose", async () => {
  await renderPanel({ groups, onDecision: vi.fn() });

  // 影响数量与受影响 Agent 由成员聚合；第二个成员无 Agent 证据，
  // 不阻止第一个成员的登记 Agent 出现。
  expect(
    screen.getByText("2 个 Skill 将导入集中库。受影响 Agent：trae.code、zcode.shared。"),
  ).toBeVisible();
  expect(screen.getByText("通用目录直接读取")).toBeVisible();
  // 回退方式按分类给出，文案来自 i18n 而不是后端。
  expect(
    screen.getByText("回退方式：共享目录原件不会被本操作修改。"),
  ).toBeVisible();
  expect(screen.getByText("同名不同内容")).toBeVisible();
  // "原件保留" 动作在两个分组都出现：至少存在且可见即可。
  expect(screen.getAllByText("原件保留").length).toBeGreaterThan(0);
});

it("shows member source paths when a group is expanded", async () => {
  await renderPanel({ groups, onDecision: vi.fn() });

  fireEvent.click(screen.getByRole("button", { name: "展开 2 个项目" }));
  expect(screen.getByText("来源路径：/home/user/.agents/skills/pdf")).toBeVisible();
  expect(screen.getByText("来源路径：/home/user/.agents/skills/notes")).toBeVisible();
});

it("confirms a deterministic group, expands members, and gives an item override precedence", async () => {
  const onDecision = vi.fn();
  await renderPanel({ groups, onDecision });

  fireEvent.click(screen.getByRole("button", { name: "展开 2 个项目" }));
  fireEvent.click(screen.getByRole("radio", { name: "PDF：创建待办" }));

  expect(onDecision).toHaveBeenLastCalledWith({
    group_actions: {},
    item_overrides: { pdf: "create_todo" },
  });
});

it("keeps deterministic defaults selectable per group", async () => {
  const onDecision = vi.fn();
  await renderPanel({ groups, onDecision });

  // 同名不同内容组的默认动作是创建待办；显式选择分组动作后按选择回传。
  const articles = screen.getAllByRole("article");
  fireEvent.click(
    within(articles[1]).getByRole("radio", { name: "创建待办" }),
  );

  expect(onDecision).toHaveBeenLastCalledWith({
    group_actions: { "same-name-different-content": "create_todo" },
    item_overrides: {},
  });
});

it("makes AI absence advisory without inventing a todo link", async () => {
  await renderPanel({ aiAvailable: false, groups, onDecision: vi.fn() });

  expect(screen.getByText("AI 建议未配置；已保留确定性关系判断。")).toBeVisible();
  expect(screen.queryByRole("link", { name: /治理待办/ })).not.toBeInTheDocument();
});

it("renders relationship governance copy in the active English locale", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <RelationshipGovernancePanel aiAvailable={false} groups={groups} onDecision={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getByRole("heading", { name: "Review relationship handling after import" })).toBeVisible();
  expect(screen.getByText("Shared directory reads")).toBeVisible();
  expect(
    screen.getByText(
      "2 skills will be imported into the central library. Affected agents: trae.code, zcode.shared.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Recovery: the shared directory itself is not modified by this action.",
    ),
  ).toBeVisible();
  expect(screen.getByText("AI suggestions are not configured; deterministic relationship checks remain in force.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Expand 2 items" })).toBeVisible();
});

// --- Task 8: 冲突组区可选 AI 分析 ---

const conflictCases: ConflictCaseFact[] = [
  {
    conflict_id: "conflict:notes",
    kind: "same_name_different_content",
    classification: "uncertain",
    member_skill_ids: [],
    members: [
      {
        skill_id: null,
        version_id: null,
        provenance_id: null,
        directory_node_id: null,
        path: "/lib/notes",
        fingerprint: "sha256:a",
      },
      {
        skill_id: null,
        version_id: null,
        provenance_id: null,
        directory_node_id: null,
        path: "/agent/notes",
        fingerprint: "sha256:b",
      },
    ],
    evidence: {
      fingerprints_match: false,
      names_match: true,
      identity_direction: null,
      sufficient_identity_evidence: false,
    },
    user_decision: null,
    decided_at: null,
  },
];

const conflictAnalysisResult: ConflictAnalysis = {
  scope: { type: "case", value: { conflict_id: "conflict:notes" } },
  input_fingerprint: "sha256:input",
  skipped_decided_cases: 0,
  total_case_count: 1,
  source: "llm",
  failure_code: null,
  cases: [
    {
      conflict_id: "conflict:notes",
      baseline_classification: "uncertain",
      summary: "成员指纹不同，无法确认是否同一 Skill。",
      recommended_action: "keep_uncertain",
      recommended_keep_member: null,
      key_evidence: ["成员指纹不同"],
      uncertainties: ["版本字段缺失"],
      confidence: 40,
    },
  ],
};

it("lists deterministic conflict cases first and offers all category and case scopes", async () => {
  const onAnalyze = vi.fn();
  await renderPanel({
    aiAvailable: true,
    conflictAnalysis: { cases: conflictCases, onAnalyze, running: false },
    groups,
    onDecision: vi.fn(),
  });

  // 确定性事实先于任何 AI 结论展示：冲突组 ID、成员路径与基线分类常显。
  expect(screen.getByText("conflict:notes")).toBeVisible();
  expect(screen.getByText("/lib/notes")).toBeVisible();
  expect(screen.getAllByText(/确定性基线/).length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { name: "AI 分析" }));
  expect(onAnalyze).toHaveBeenLastCalledWith({
    type: "case",
    value: { conflict_id: "conflict:notes" },
  });

  fireEvent.click(screen.getByRole("button", { name: "按分类分析：证据不足（待办）" }));
  expect(onAnalyze).toHaveBeenLastCalledWith({
    type: "category",
    value: { classification: "uncertain" },
  });

  fireEvent.click(screen.getByRole("button", { name: "分析全部未决冲突" }));
  expect(onAnalyze).toHaveBeenLastCalledWith({ type: "all" });
});

it("renders the returned short conclusion with its baseline and the advisory note", async () => {
  await renderPanel({
    aiAvailable: true,
    conflictAnalysis: {
      cases: conflictCases,
      onAnalyze: vi.fn(),
      result: conflictAnalysisResult,
      running: false,
    },
    groups,
    onDecision: vi.fn(),
  });

  expect(screen.getByText("成员指纹不同，无法确认是否同一 Skill。")).toBeVisible();
  expect(screen.getByText(/建议动作/)).toBeVisible();
  expect(screen.getByText("置信度：40%")).toBeVisible();
  expect(screen.getByText("版本字段缺失")).toBeVisible();
  // 建议只是建议：不改变用户裁决的说明必须出现。
  expect(
    screen.getByText("AI 结果仅供参考，不会自动合并、删除或改变你的裁决。"),
  ).toBeVisible();
  // 基线先于 AI 结论出现。
  const section = screen.getByTestId("conflict-analysis-section");
  const sectionText = section.textContent ?? "";
  expect(sectionText.indexOf("确定性基线")).toBeLessThan(
    sectionText.indexOf("成员指纹不同，无法确认是否同一 Skill。"),
  );
});

it("reports a failed conflict analysis through a readable reason and keeps the baselines", async () => {
  await renderPanel({
    aiAvailable: true,
    conflictAnalysis: {
      cases: conflictCases,
      onAnalyze: vi.fn(),
      result: {
        ...conflictAnalysisResult,
        source: "deterministic_only",
        failure_code: "llm.request_timeout",
        cases: [],
      },
      running: false,
    },
    groups,
    onDecision: vi.fn(),
  });

  expect(screen.getByText(/冲突分析未能完成：连接模型服务超时/)).toBeVisible();
  expect(screen.getByText("确定性冲突分组不受影响。")).toBeVisible();
  expect(screen.getByText("conflict:notes")).toBeVisible();
});

it("hides conflict analysis actions when AI is unavailable without hiding the facts", async () => {
  const onAnalyze = vi.fn();
  await renderPanel({
    aiAvailable: false,
    conflictAnalysis: { cases: conflictCases, onAnalyze, running: false },
    groups,
    onDecision: vi.fn(),
  });

  expect(screen.queryByRole("button", { name: "AI 分析" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "分析全部未决冲突" })).not.toBeInTheDocument();
  // 事实仍在：确定性基线不因 AI 缺席而消失。
  expect(screen.getByText("conflict:notes")).toBeVisible();
  expect(
    screen.getByText("AI 建议未配置；已保留确定性关系判断。"),
  ).toBeVisible();
});

it("disables conflict analysis actions while a run is in progress", async () => {
  const onAnalyze = vi.fn();
  await renderPanel({
    aiAvailable: true,
    conflictAnalysis: { cases: conflictCases, onAnalyze, running: true },
    groups,
    onDecision: vi.fn(),
  });

  expect(screen.getByRole("button", { name: "AI 分析" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "分析全部未决冲突" })).toBeDisabled();
});

it("states partial coverage honestly when the scope exceeds one request", async () => {
  const onAnalyze = vi.fn();
  await renderPanel({
    aiAvailable: true,
    conflictAnalysis: {
      cases: conflictCases,
      onAnalyze,
      running: false,
      result: {
        ...conflictAnalysisResult,
        total_case_count: 20,
        cases: conflictAnalysisResult.cases,
      },
    },
    groups,
    onDecision: vi.fn(),
  });

  expect(screen.getByText("本次已分析 1 组（范围内共 20 组）")).toBeVisible();
});
