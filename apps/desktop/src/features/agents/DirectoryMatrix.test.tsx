import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { RelationshipOverview } from "../api/bindings";
import { DirectoryMatrix } from "./DirectoryMatrix";

const now = "2026-09-15T00:00:00Z";

const overview: RelationshipOverview = {
  scope: { type: "agent", value: { agent_client_id: "codex-cli" } },
  directory_nodes: [
    {
      node_id: "node-shared",
      path: "/home/demo/.agents/skills",
      path_key: "pk-shared",
      role: "shared_directory",
      profile_id: null,
      agent_client_id: null,
      exists: true,
      observed_at: now,
      scan_source: "profile",
    },
    {
      node_id: "node-native",
      path: "/home/demo/.codex/skills",
      path_key: "pk-native",
      role: "agent_native",
      profile_id: "openai",
      agent_client_id: "codex-cli",
      exists: true,
      observed_at: now,
      scan_source: "profile",
    },
    {
      node_id: "node-ghost",
      path: "/home/demo/.ghost/skills",
      path_key: "pk-ghost",
      role: "agent_native",
      profile_id: "openai",
      agent_client_id: "codex-cli",
      exists: false,
      observed_at: now,
      scan_source: "profile",
    },
  ],
  agent_directory_capabilities: [
    {
      agent_client_id: "codex-cli",
      directory_node_id: "node-shared",
      recognition: "supported",
      precedence: "preferred",
      evidence_reference: "https://developers.openai.com/codex/skills",
      researched_at: "2026-09-01",
      applicable_platforms: ["macos", "windows"],
    },
    {
      agent_client_id: "codex-cli",
      directory_node_id: "node-native",
      recognition: "unknown",
      precedence: "unknown",
      evidence_reference: null,
      researched_at: null,
      applicable_platforms: [],
    },
    {
      agent_client_id: "trae.code",
      directory_node_id: "node-shared",
      recognition: "unknown",
      precedence: "unknown",
      evidence_reference: null,
      researched_at: null,
      applicable_platforms: [],
    },
  ],
  source_relations: [],
  deployment_relations: [
    {
      relation_id: "rel-read",
      skill_id: "skill-pdf",
      agent_client_id: "codex-cli",
      path: "/home/demo/.agents/skills/pdf",
      path_key: "pk-pdf",
      directory_node_id: "node-shared",
      relationship: "shared_directory_read",
      file_representation: "directory",
      ownership: "shared_reference",
      link_target_path: null,
      link_target_path_key: null,
      link_target_directory_id: null,
      content_fingerprint: "sha256:aa",
      origin: "scan",
      match_state: "content_verified",
      active: true,
      observed_at: now,
      released_at: null,
    },
    {
      relation_id: "rel-ref",
      skill_id: "skill-notes",
      agent_client_id: "codex-cli",
      path: "/home/demo/.codex/skills/notes",
      path_key: "pk-notes",
      directory_node_id: "node-native",
      relationship: "shared_directory_reference",
      file_representation: "symbolic_link",
      ownership: "shared_reference",
      link_target_path: "/home/demo/.agents/skills/notes",
      link_target_path_key: "pk-shared-notes",
      link_target_directory_id: "node-shared",
      content_fingerprint: "sha256:bb",
      origin: "scan",
      match_state: "content_verified",
      active: true,
      observed_at: now,
      released_at: null,
    },
    {
      relation_id: "rel-copy",
      skill_id: "skill-review",
      agent_client_id: "codex-cli",
      path: "/home/demo/.codex/skills/review",
      path_key: "pk-review",
      directory_node_id: "node-native",
      relationship: "managed_copy",
      file_representation: "copy",
      ownership: "skillhub_managed",
      link_target_path: null,
      link_target_path_key: null,
      link_target_directory_id: null,
      content_fingerprint: "sha256:cc",
      origin: "import",
      match_state: "name_only",
      active: true,
      observed_at: now,
      released_at: null,
    },
  ],
  conflict_cases: [],
  pending_governance_tasks: [],
  agent_execution_confirmed: false,
};

async function renderMatrix(
  props: Omit<Parameters<typeof DirectoryMatrix>[0], never> = {},
  locale: "zh-CN" | "en-US" = "zh-CN",
) {
  const i18n = await createSkillHubI18n([locale]);
  render(
    <I18nextProvider i18n={i18n}>
      <DirectoryMatrix currentAgentClientId="codex-cli" overview={overview} {...props} />
    </I18nextProvider>,
  );
  return i18n;
}

it("renders the generic shared directory card first with the agent recognition status", async () => {
  await renderMatrix();

  const cards = screen.getAllByTestId("directory-card");
  expect(cards).toHaveLength(3);
  const shared = within(cards[0]);
  expect(shared.getByText("/home/demo/.agents/skills")).toBeVisible();
  expect(shared.getByText("通用共享目录")).toBeVisible();
  // 识别状态来自登记的能力事实：当前 Agent 对通用目录是"已确认支持"。
  expect(shared.getByText("已确认支持")).toBeVisible();
  expect(shared.getByText("已确认支持")).toHaveClass("sh-status-badge--success");
  // 共享消费者：识别该目录的其他 Agent；当前 Agent 自身不出现。
  expect(shared.getByText("共享消费者：trae.code")).toBeVisible();
});

it("labels relations with user semantics and keeps link types in technical details", async () => {
  const user = userEvent.setup();
  await renderMatrix();

  // 通用目录直接读取与 Agent 自有目录的链接引用/复制部署都按用户语义命名。
  expect(screen.getByText("共享目录直接读取")).toBeVisible();
  expect(screen.getByText("共享目录链接引用")).toBeVisible();
  expect(screen.getByText("复制部署")).toBeVisible();
  // "外部链接"绝不是关系名称；链接类型只出现在技术详情中。
  expect(screen.queryByText(/外部链接/)).not.toBeInTheDocument();

  const cards = screen.getAllByTestId("directory-card");
  const nativeCard = within(cards[1]);
  const refRow = nativeCard.getAllByTestId("directory-relation")[0];
  expect(within(refRow).getByText("skill-notes")).toBeVisible();
  await user.click(within(refRow).getByText("技术详情"));
  expect(within(refRow).getByText("符号链接")).toBeVisible();
  expect(within(refRow).getByText("链接目标：/home/demo/.agents/skills/notes")).toBeVisible();
});

it("counts unique active skills and lists per-skill relation entries", async () => {
  await renderMatrix();

  const cards = screen.getAllByTestId("directory-card");
  // 通用共享目录：只有 skill-pdf 一个活动 Skill。
  expect(within(cards[0]).getByText("1 个 Skill")).toBeVisible();
  // Agent 自有目录：skill-notes 与 skill-review 两个活动 Skill。
  expect(within(cards[1]).getByText("2 个 Skill")).toBeVisible();
});

it("marks directories without registered recognition as unconfirmed instead of guessing", async () => {
  await renderMatrix();

  const cards = screen.getAllByTestId("directory-card");
  const ghost = within(cards[2]);
  expect(ghost.getByText("未登记识别能力")).toBeVisible();
  expect(ghost.getByText("0 个 Skill")).toBeVisible();
});

it("states that recognition never proves loading or invocation", async () => {
  await renderMatrix();

  const note = screen.getByTestId("directory-matrix-execution-note");
  expect(note).toBeVisible();
  expect(note.textContent).toContain("不代表该 Agent 已加载或一定会调用");
  // 概览契约本身也永远不携带"已执行确认"事实。
  expect(overview.agent_execution_confirmed).toBe(false);
});

it("offers a removal impact entry per active relation and shows deterministic facts", async () => {
  const user = userEvent.setup();
  const onLoadRemovalImpact = vi.fn(async (relationId: string) => ({
    relation_id: relationId,
    relation: null,
    ownership: "skillhub_managed" as const,
    current_agent_reads_shared_directory: relationId === "rel-read",
    other_consumers: [{
      agent_client_id: "trae.code",
      relation_id: null,
      directory_node_id: "node-shared",
      recognition: "unknown" as const,
    }],
    other_skill_paths: [{
      relation_id: "rel-other",
      path: "/home/demo/.trae/skills/pdf",
      relationship: "managed_copy" as const,
      file_representation: "copy" as const,
    }],
    minimal_action: "remove_current_shared_alias" as const,
    backup: { required: true, rollback_available: true, backup_location: "/backups/rel-read", detail: "backup kept" },
    governance_tasks: [{
      task_id: "task-1",
      kind: "confirm_shared_directory_impact" as const,
      subject_id: relationId,
      detail: "confirm",
      resolved: false,
      created_at: now,
      resolved_at: null,
    }],
    permission_limited: true,
  }));
  await renderMatrix({ onLoadRemovalImpact });

  const buttons = screen.getAllByRole("button", { name: "查看移除影响" });
  expect(buttons.length).toBeGreaterThanOrEqual(3);
  await user.click(buttons[0]);

  const facts = await screen.findByTestId("removal-impact-facts");
  expect(facts.textContent).toContain("建议只移除当前别名，共享目录本体与其他引用保持不变");
  expect(facts.textContent).toContain("当前 Agent 直接读取该通用共享目录。");
  expect(facts.textContent).toContain("其他识别该目录的 Agent：trae.code (识别能力未确认)");
  expect(facts.textContent).toContain("同一 Skill 的其他路径：/home/demo/.trae/skills/pdf (复制部署)");
  expect(facts.textContent).toContain("可回退；备份位置：/backups/rel-read");
  expect(facts.textContent).toContain("权限受限");
  expect(facts.textContent).toContain("关联待办：1 项");
  expect(onLoadRemovalImpact).toHaveBeenCalledWith("rel-read");
});

it("shows an honest error when the removal impact cannot load", async () => {
  const user = userEvent.setup();
  await renderMatrix({ onLoadRemovalImpact: async () => {
    throw new Error("impact unavailable");
  } });

  await user.click(screen.getAllByRole("button", { name: "查看移除影响" })[0]);
  expect(await screen.findByRole("alert")).toHaveTextContent("无法加载移除影响。");
});

it("keeps an honest empty state when no relationship facts exist", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DirectoryMatrix currentAgentClientId="codex-cli" overview={{
        ...overview,
        directory_nodes: [],
        deployment_relations: [],
        agent_directory_capabilities: [],
      }} />
    </I18nextProvider>,
  );

  expect(screen.getByTestId("directory-matrix-empty")).toBeVisible();
});

it("renders English copy with the same structure", async () => {
  await renderMatrix({}, "en-US");

  const cards = screen.getAllByTestId("directory-card");
  const shared = within(cards[0]);
  expect(shared.getByText("Shared directory")).toBeVisible();
  expect(shared.getByText("Recognition confirmed")).toBeVisible();
  expect(screen.getByText("Shared directory direct read")).toBeVisible();
  expect(screen.getByText("Copy deployment")).toBeVisible();
  expect(screen.getByTestId("directory-matrix-execution-note").textContent).toContain(
    "does not mean the agent has loaded",
  );
});
