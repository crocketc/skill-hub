import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { RelationshipGovernancePanel } from "./RelationshipGovernancePanel";
import type { ImportGovernanceGroup } from "./relationshipGovernance";

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
