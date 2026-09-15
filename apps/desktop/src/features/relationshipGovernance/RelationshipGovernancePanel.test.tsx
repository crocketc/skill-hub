import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { RelationshipGovernancePanel } from "./RelationshipGovernancePanel";
import type { ImportGovernanceGroup } from "./relationshipGovernance";

const groups: ImportGovernanceGroup[] = [{
  group_id: "agent-managed-source",
  classification: "agent_managed_source",
  impact_summary: "2 个 Agent 共用此目录；导入集中库不会删除原件。",
  default_action: "preserve_original",
  available_actions: ["preserve_original", "create_todo"],
  members: [
    { member_id: "pdf", display_name: "PDF" },
    { member_id: "notes", display_name: "Notes" },
  ],
}];

async function renderPanel(props: ComponentProps<typeof RelationshipGovernancePanel>) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <RelationshipGovernancePanel {...props} />
    </I18nextProvider>,
  );
}

it("confirms a deterministic group, expands members, and gives an item override precedence", async () => {
  const onDecision = vi.fn();
  await renderPanel({ groups, onDecision });

  expect(screen.getByText("2 个 Agent 共用此目录；导入集中库不会删除原件。")).toBeVisible();
  expect(screen.getByText("原件保留")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "展开 2 个项目" }));
  fireEvent.click(screen.getByRole("radio", { name: "PDF：创建待办" }));

  expect(onDecision).toHaveBeenLastCalledWith({
    group_actions: {},
    item_overrides: { pdf: "create_todo" },
  });
});

it("makes AI absence advisory without inventing a todo link", async () => {
  await renderPanel({ aiAvailable: false, groups, onDecision: vi.fn() });

  expect(screen.getByText("AI 建议未配置；已保留确定性关系判断。")).toBeVisible();
  expect(screen.queryByRole("link", { name: /治理待办/ })).not.toBeInTheDocument();
});

it("uses the deterministic group default until a group action is explicitly selected", async () => {
  const onDecision = vi.fn();
  await renderPanel({ groups, onDecision });

  fireEvent.click(screen.getByRole("button", { name: "展开 2 个项目" }));
  expect(screen.getByRole("radio", { name: "PDF：原件保留" })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "创建待办" }));

  expect(onDecision).toHaveBeenLastCalledWith({
    group_actions: { "agent-managed-source": "create_todo" },
    item_overrides: {},
  });
});

it("renders relationship governance copy in the active English locale", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <RelationshipGovernancePanel aiAvailable={false} groups={groups} onDecision={vi.fn()} />
    </I18nextProvider>,
  );

  expect(screen.getByRole("heading", { name: "Review relationship handling after import" })).toBeVisible();
  expect(screen.getByText("Importing into the central library and handling original copies are separate actions; every change needs confirmation, impact details, and a recovery path.")).toBeVisible();
  expect(screen.getByText("AI suggestions are not configured; deterministic relationship checks remain in force.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Expand 2 items" })).toBeVisible();
});
