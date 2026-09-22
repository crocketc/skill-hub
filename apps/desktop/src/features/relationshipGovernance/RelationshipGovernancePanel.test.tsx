import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { RelationshipGovernancePanel } from "./RelationshipGovernancePanel";
import type { ImportGovernanceGroup } from "./relationshipGovernance";
import type { ConflictCaseFact } from "../../api/bindings";

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
      <MemoryRouter>
        <RelationshipGovernancePanel {...props} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

it("renders structured impact facts per group without backend prose", async () => {
  await renderPanel({ groups, onDecision: vi.fn() });

  // 影响数量与受影响 Agent 由成员聚合；第二个成员无 Agent 证据，
  // 不阻止第一个成员的登记 Agent 出现。
  expect(screen.getByText(/2 个 Skill 将导入集中库。受影响 Agent：/)).toBeVisible();
  expect(screen.getAllByLabelText("Trae · 终端").length).toBeGreaterThan(0);
  expect(screen.getAllByLabelText("共享目录").length).toBeGreaterThan(0);
  expect(screen.getByText("通用目录直接读取")).toBeVisible();
  // 回退方式按分类给出，文案来自 i18n 而不是后端。
  expect(
    screen.getByText("回退方式：共享目录原件不会被本操作修改。"),
  ).toBeVisible();
  expect(screen.getByText("同名不同内容")).toBeVisible();
  // "保留原件，不导入" 动作在两个分组都出现：至少存在且可见即可。
  expect(screen.getAllByText("保留原件，不导入").length).toBeGreaterThan(0);
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
  fireEvent.click(screen.getByRole("radio", { name: "PDF：先不导入，记为待办" }));

  expect(onDecision).toHaveBeenLastCalledWith({
    group_actions: {},
    item_overrides: { pdf: "create_todo" },
  });
});

it("keeps deterministic defaults selectable per group", async () => {
  const onDecision = vi.fn();
  await renderPanel({ groups, onDecision });

  // 同名不同内容组的默认动作是先不导入，记为待办；显式选择分组动作后按选择回传。
  const articles = screen.getAllByRole("article");
  fireEvent.click(
    within(articles[1]).getByRole("radio", { name: "先不导入，记为待办" }),
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
  expect(screen.getByText(/2 skills will be imported into the central library. Affected agents:/)).toBeVisible();
  expect(screen.getAllByLabelText("Trae · Terminal").length).toBeGreaterThan(0);
  expect(screen.getAllByLabelText("Shared directory").length).toBeGreaterThan(0);
  expect(
    screen.getByText(
      "Recovery: the shared directory itself is not modified by this action.",
    ),
  ).toBeVisible();
  expect(screen.getByText("AI suggestions are not configured; deterministic relationship checks remain in force.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Expand 2 items" })).toBeVisible();
});

// --- 任务 7 清理后：冲突组只留确定性摘要与工作台深链 ---

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

it("lists deterministic conflict facts and deep-links to the decisions workspace", async () => {
  await renderPanel({
    aiAvailable: true,
    conflictCases: conflictCases,
    groups,
    onDecision: vi.fn(),
  });

  // 确定性事实常显：冲突组 ID、成员路径与分类。
  expect(screen.getByText("conflict:notes")).toBeVisible();
  expect(screen.getByText("/lib/notes")).toBeVisible();
  expect(screen.getByText("证据不足（待办）")).toBeVisible();
  // 深链携带冲突上下文，AI 分析集中到冲突处理工作台。
  const link = screen.getByRole("link", { name: "前往冲突处理" });
  expect(link).toHaveAttribute(
    "href",
    "/relationships/decisions?conflictId=conflict:notes",
  );
  expect(screen.getByText("冲突组的 AI 分析与裁决集中在冲突处理工作台完成。")).toBeVisible();
  // 旧位置不再有 AI 冲突入口，也不渲染 AI 结论。
  expect(screen.queryByRole("button", { name: "AI 分析" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /分析全部/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/建议动作/)).not.toBeInTheDocument();
  expect(screen.queryByText(/置信度/)).not.toBeInTheDocument();
});

it("keeps the deterministic conflict facts visible when AI is unavailable", async () => {
  await renderPanel({
    aiAvailable: false,
    conflictCases: conflictCases,
    groups,
    onDecision: vi.fn(),
  });

  expect(screen.getByText("conflict:notes")).toBeVisible();
  expect(screen.getByRole("link", { name: "前往冲突处理" })).toBeVisible();
});

it("shows no conflict section when the host supplies no conflict cases", async () => {
  await renderPanel({ groups, onDecision: vi.fn() });

  expect(screen.queryByTestId("conflict-cases-section")).not.toBeInTheDocument();
});
