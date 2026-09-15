import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RelationshipGovernancePanel } from "./RelationshipGovernancePanel";
import type { ImportGovernanceGroup } from "./relationshipGovernance";

const groups: ImportGovernanceGroup[] = [{
  id: "shared-agent-directory",
  classification: "shared_directory",
  impactSummary: "2 个 Agent 共用此目录；导入集中库不会删除原件。",
  defaultAction: "keep_original",
  availableActions: ["keep_original", "create_todo", "convert_to_managed_link"],
  members: [
    { candidateId: "pdf", name: "PDF", detail: "由 Codex 与 Claude 共用" },
    { candidateId: "notes", name: "Notes", detail: "目录权限待确认" },
  ],
}];

it("confirms a deterministic group, expands members, and gives an item override precedence", () => {
  const onDecision = vi.fn();
  render(<RelationshipGovernancePanel groups={groups} onDecision={onDecision} />);

  expect(screen.getByText("2 个 Agent 共用此目录；导入集中库不会删除原件。")).toBeVisible();
  expect(screen.getByText("原件保留")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "展开 2 个项目" }));
  fireEvent.click(screen.getByRole("radio", { name: "PDF：建立受管链接" }));

  expect(onDecision).toHaveBeenLastCalledWith({
    groupActions: {},
    itemOverrides: { pdf: "convert_to_managed_link" },
  });
});

it("makes AI absence advisory and retains a recoverable todo entry", () => {
  render(<RelationshipGovernancePanel aiAvailable={false} groups={groups} onDecision={vi.fn()} />);

  expect(screen.getByText("AI 建议未配置；已保留确定性关系判断。")).toBeVisible();
  expect(screen.getByRole("link", { name: "前往关系治理待办" })).toHaveAttribute("href", "#relationship-governance");
});
