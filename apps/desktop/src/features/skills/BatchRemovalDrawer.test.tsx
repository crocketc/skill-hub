import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { RemovalImpact } from "../removal/api";
import { BatchRemovalDrawer } from "./BatchRemovalDrawer";

const impacts: RemovalImpact[] = [
  {
    combinations: [],
    declaredDependencies: [],
    deployments: [
      {
        id: "claude-code",
        label: "anthropic.claude-code",
        path: "C:/Users/crock/.claude/skills",
        physicalId: "claude-skills",
        agentId: "anthropic.claude-code",
        brand: "anthropic",
        sharedDirectory: false,
      },
    ],
    dependentProjects: [],
    operationId: "delete-cangjie",
    pinnedVersions: [],
    relatedSkills: [],
    skillId: "cangjie-skill",
    skillName: "cangjie-skill",
    unknownExternalReferences: [
      "C:\\Users\\crock\\.agents\\skills\\cangjie-skill",
      "C:\\Users\\crock\\claude\\skills\\cangjie-skill",
    ],
  },
];

async function renderDrawer(
  props: Partial<Parameters<typeof BatchRemovalDrawer>[0]> = {},
) {
  const i18n = await createSkillHubI18n(["en-US"]);
  const onConfirm = vi.fn();
  const merged = { impacts, onCancel: vi.fn(), onConfirm, ...props };
  const view = render(
    <I18nextProvider i18n={i18n}>
      <BatchRemovalDrawer {...merged} />
    </I18nextProvider>,
  );
  return { ...merged, baseElement: view.baseElement };
}

// DEV-97：抽屉头部已带流程说明，正文不得重复渲染同一句。
it("states the flow description exactly once", async () => {
  const { baseElement } = await renderDrawer();

  expect(screen.getAllByText(/selected for deletion from the library/)).toHaveLength(1);
  // 正文里的旧 eyebrow 只会与抽屉标题重复，一并移除。
  expect(screen.queryByText("Batch deletion impact")).toBeNull();
  expect(baseElement.querySelectorAll(".sh-drawer__description")).toHaveLength(1);
});

// DEV-97：AGENTS.md Agent 呈现约定——部署目标必须呈现为品牌厂商 + 用户可理解
// 类型徽标，技术 client_id 不得裸奔。
it("presents the deployment target as brand and kind instead of a technical client id", async () => {
  const { baseElement } = await renderDrawer();

  // 抽屉经 radix portal 渲染，需在 document 层查询。
  expect(baseElement.querySelector(".sh-agent-presentation")).not.toBeNull();
  // anthropic → Claude（品牌显示名）；.code → 终端类型徽标。
  expect(screen.getByText("Claude")).toBeVisible();
  expect(screen.getByText("Terminal")).toBeVisible();
  expect(screen.queryByText("anthropic.claude-code")).toBeNull();
});

// DEV-97：影响矩阵逐项结构化呈现——每个未知外部引用占一条，不再拼成长段。
it("lists each unknown external reference as its own entry", async () => {
  await renderDrawer();

  const dimension = screen
    .getByText(/Unknown external references/)
    .closest("li") as HTMLElement;
  const entries = within(dimension).getAllByRole("listitem");
  expect(entries).toHaveLength(2);
  expect(entries[0]).toHaveTextContent("cangjie-skill");
});

// DEV-97：无部署关系时按钮语义就是删除本身，不再自相矛盾地说「强制」。
it("uses the plain delete action when no deployment relations need handling", async () => {
  const { onConfirm } = await renderDrawer({
    impacts: [{ ...impacts[0], deployments: [] }],
  });

  expect(screen.getByText(/No deployment relations need handling\./)).toBeVisible();
  const proceed = screen.getByRole("button", { name: "Delete" });
  expect(proceed).toBeEnabled();

  // QA-001 二次点击确认保持不变（英文文案不分化单复数）。
  fireEvent.click(proceed);
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Click again to confirm deleting 1 Skills" }),
  );
  expect(onConfirm).toHaveBeenCalledWith({ "delete-cangjie": {} });
});
