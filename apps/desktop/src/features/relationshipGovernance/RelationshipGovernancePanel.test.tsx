import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
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

it("confirms a deterministic group, expands members, and gives an item override precedence", () => {
  const onDecision = vi.fn();
  render(<RelationshipGovernancePanel groups={groups} onDecision={onDecision} />);

  expect(screen.getByText("2 个 Agent 共用此目录；导入集中库不会删除原件。")).toBeVisible();
  expect(screen.getByText("原件保留")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "展开 2 个项目" }));
  fireEvent.click(screen.getByRole("radio", { name: "PDF：创建待办" }));

  expect(onDecision).toHaveBeenLastCalledWith({
    group_actions: {},
    item_overrides: { pdf: "create_todo" },
  });
});

it("makes AI absence advisory without inventing a todo link", () => {
  render(<RelationshipGovernancePanel aiAvailable={false} groups={groups} onDecision={vi.fn()} />);

  expect(screen.getByText("AI 建议未配置；已保留确定性关系判断。")).toBeVisible();
  expect(screen.queryByRole("link", { name: /治理待办/ })).not.toBeInTheDocument();
});
