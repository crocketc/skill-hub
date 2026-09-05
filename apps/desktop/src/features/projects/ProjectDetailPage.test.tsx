import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { projectFixture, type ProjectFacade, type ProjectView } from "./api";
import { BestEffortAssembly } from "./BestEffortAssembly";
import { ProjectDetailPage } from "./ProjectDetailPage";

function detailFacade(project: ProjectView, overrides: Partial<ProjectFacade> = {}): ProjectFacade {
  return {
    get: async () => project,
    list: async () => [project],
    register: async () => project,
    updateAgentIds: async () => project,
    listAgentCandidates: async () => [],
    previewDirectory: async () => ({ path: "", agentTraces: [], skillCandidates: [] }),
    getAssemblyPlan: async () => null,
    listPhysicalTargets: async () => [],
    ...overrides,
  };
}

it("keeps satisfied, skipped, conflict and failed assembly entries visible", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
      <BestEffortAssembly items={projectFixture().assembly} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  expect(screen.getByText("满足")).toBeVisible();
  expect(screen.getByText("已跳过")).toBeVisible();
  expect(screen.getByText("冲突")).toBeVisible();
  expect(screen.getByText("失败")).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
});

it("shows shared configuration as read-only project facts", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  const project = projectFixture();
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
      <ProjectDetailPage facade={detailFacade(project)} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  expect(await screen.findByText("C:/Projects/demo")).toBeVisible();
  expect(screen.getByText("Project Skill assembly")).toBeVisible();
  expect(screen.getByText("No assembly plan exists yet; project requirements are not deployed from here.")).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("updates the Agent associations without changing the project shared configuration", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = { ...projectFixture(), agentIds: ["codex-cli"] };
  const updateAgentIds = vi.fn(async (_projectId: string, agentIds: string[]) => ({ ...project, agentIds }));
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
      <ProjectDetailPage facade={detailFacade(project, {
        updateAgentIds,
        listAgentCandidates: async () => [
          { id: "codex-cli", label: "OpenAI · Codex CLI", available: true },
          { id: "claude-code", label: "Anthropic · Claude Code", available: true },
        ],
      })} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("checkbox", { name: "Anthropic · Claude Code" }));
  await user.click(screen.getByRole("button", { name: "保存关联" }));

  expect(updateAgentIds).toHaveBeenCalledWith("demo-project", ["codex-cli", "claude-code"]);
  expect(screen.getByText("已保存 Agent 关联。")).toBeVisible();
});

it.each([
  ["accessible", { exists: true, id: "fs-aurora", path: "D:/Work/Aurora", readable: true, writable: true }, "可访问"],
  ["read only", { exists: true, id: "fs-aurora", path: "D:/Work/Aurora", readable: true, writable: false }, "只读"],
  ["inaccessible", { exists: false, id: "fs-aurora", path: "D:/Work/Aurora", readable: false, writable: false }, "不可访问"],
])("labels the project %s from the matching physical target", async (_kind, target, label) => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = { ...projectFixture(), devicePath: "D:/Work/Aurora", physicalId: "fs-aurora" };
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
      <ProjectDetailPage facade={detailFacade(project, { listPhysicalTargets: async () => [target] })} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  expect(await screen.findByText("D:/Work/Aurora")).toBeVisible();
  expect(screen.getByText(label)).toBeVisible();
});

it("says honestly when the discovery snapshot has no matching physical target", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = { ...projectFixture(), devicePath: "D:/Work/Aurora", physicalId: "fs-unknown" };
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
      <ProjectDetailPage facade={detailFacade(project)} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  expect(await screen.findByText("D:/Work/Aurora")).toBeVisible();
  expect(screen.getByText("未在发现快照中找到对应物理目标，无法判断访问状态。")).toBeVisible();
});

it("says honestly when the discovery snapshot cannot be read", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = { ...projectFixture(), devicePath: "D:/Work/Aurora", physicalId: "fs-aurora" };
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
      <ProjectDetailPage facade={detailFacade(project, { listPhysicalTargets: vi.fn(async () => { throw new Error("down"); }) })} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  expect(await screen.findByText("无法读取发现快照，暂时无法判断访问状态。")).toBeVisible();
});

it("groups assembly plan items by status with counts and members", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const plan = {
    items: [
      { name: "PDF Reader", reasons: [], skillId: "pdf-reader", status: "already_satisfied" as const },
      { name: "Research", reasons: ["需要获取"], skillId: "research", status: "ready_to_acquire" as const },
      { name: "Writing", reasons: [], skillId: "writing", status: "ready_to_acquire" as const },
      { name: "Release Notes", reasons: ["同名冲突"], skillId: "release-notes", status: "conflict_needs_choice" as const },
      { name: "Browser Helper", reasons: [], skillId: "browser-helper", status: "skipped" as const },
    ],
  };
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
      <ProjectDetailPage facade={detailFacade(projectFixture(), { getAssemblyPlan: async () => plan })} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  expect(await screen.findByText("项目 Skill 装配")).toBeVisible();
  expect(screen.getByText("已满足")).toBeVisible();
  expect(screen.getByText("待获取")).toBeVisible();
  expect(screen.getByText("冲突待选择")).toBeVisible();
  expect(screen.getByText("已跳过")).toBeVisible();
  expect(screen.getByText("2 项")).toBeVisible();

  const readyGroup = screen.getByRole("list", { name: "待获取" });
  expect(within(readyGroup).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Research", "Writing"]);
  expect(screen.getByRole("list", { name: "已满足" }).querySelector("li")?.textContent).toBe("PDF Reader");
  expect(screen.getByRole("list", { name: "冲突待选择" }).querySelector("li")?.textContent).toBe("Release Notes");
  expect(screen.getByRole("list", { name: "已跳过" }).querySelector("li")?.textContent).toBe("Browser Helper");
});

it("shows an honest empty state when no assembly plan exists", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
      <ProjectDetailPage facade={detailFacade(projectFixture(), { getAssemblyPlan: async () => null })} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  expect(await screen.findByText("尚未生成装配计划，项目要求不会在这里自动部署。")).toBeVisible();
});

it("reports an assembly plan load failure instead of showing fake groups", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
      <ProjectDetailPage facade={detailFacade(projectFixture(), { getAssemblyPlan: vi.fn(async () => { throw new Error("down"); }) })} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  expect(await screen.findByText("无法读取装配计划。")).toBeVisible();
});

it("explains that detaching management is a per-deployment action without faking an entry", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
      <ProjectDetailPage facade={detailFacade(projectFixture())} />
      </MemoryRouter>
    </I18nextProvider>,
  );

  expect(await screen.findByText("解除管理针对单个部署关系，需在部署管理中按部署处理；项目详情没有可解除的部署入口。")).toBeVisible();
});
