import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { DirectoryPicker } from "../../platform/directoryPicker";
import { projectFixture, type ProjectFacade } from "./api";
import { ProjectListPage } from "./ProjectListPage";

function listFacade(project: ReturnType<typeof projectFixture>, overrides: Partial<ProjectFacade> = {}): ProjectFacade {
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

it("filters one project through multiple tags without creating a folder tree", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={listFacade(project)} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("checkbox", { name: "客户项目" }));
  await user.click(screen.getByRole("checkbox", { name: "Rust" }));

  expect(screen.getByText("Demo Project")).toBeVisible();
  expect(screen.queryByRole("tree")).not.toBeInTheDocument();
});

it("opens a flat project summary drawer from its row", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["en-US"]);
  const project = projectFixture();
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={listFacade(project)} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "Demo Project" }));
  expect(await screen.findByRole("dialog")).toBeVisible();
  expect(screen.getByText("C:/Projects/demo")).toBeVisible();
});

it("opens project management from the project summary", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const onOpenProject = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={listFacade(project)} onOpenProject={onOpenProject} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "Demo Project" }));
  await user.click(screen.getByRole("button", { name: "管理项目" }));

  expect(onOpenProject).toHaveBeenCalledWith("demo-project");
});

it("registers a user-selected local directory without creating a shared config", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const register = vi.fn(async () => project);
  const directoryPicker: DirectoryPicker = { pickDirectory: vi.fn(async () => "C:/Projects/Aurora") };
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage directoryPicker={directoryPicker} facade={listFacade(project, { list: async () => [], register, listAgentCandidates: async () => [{ id: "codex-cli", label: "OpenAI · Codex CLI", available: true }], previewDirectory: async () => ({ path: "C:/Projects/Aurora", agentTraces: [], skillCandidates: [] }) })} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "注册项目" }));
  await user.click(screen.getByRole("button", { name: "选择项目目录" }));

  expect(screen.getByText("C:/Projects/Aurora")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "项目名称" })).toHaveValue("Aurora");
  await user.click(await screen.findByRole("checkbox", { name: "OpenAI · Codex CLI" }));
  await user.click(screen.getByRole("button", { name: "确认注册" }));

  expect(register).toHaveBeenCalledWith(expect.objectContaining({
    id: expect.stringMatching(/.+/),
    name: "Aurora",
    path: "C:/Projects/Aurora",
    tags: [],
    agentIds: ["codex-cli"],
  }));
});

it("leaves project registration unchanged when directory selection is cancelled", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const register = vi.fn(async () => project);
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage directoryPicker={{ pickDirectory: vi.fn(async () => null) }} facade={listFacade(project, { list: async () => [], register })} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "注册项目" }));
  await user.click(screen.getByRole("button", { name: "选择项目目录" }));

  expect(register).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "确认注册" })).toBeDisabled();
});

it("previews the chosen directory read-only and suggests traced agents before registration", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const register = vi.fn(async () => project);
  const previewDirectory = vi.fn(async () => ({
    path: "C:/Projects/Aurora",
    agentTraces: [{
      targetId: "anthropic:claude-code:project:C:/Projects/Aurora/.claude/skills",
      label: "anthropic · anthropic.claude-code",
      path: "C:/Projects/Aurora/.claude/skills",
      marker: "SKILL.md",
      available: true,
    }],
    skillCandidates: [{ name: "research", path: "C:/Projects/Aurora/.claude/skills/research" }],
  }));
  const directoryPicker: DirectoryPicker = { pickDirectory: vi.fn(async () => "C:/Projects/Aurora") };
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage directoryPicker={directoryPicker} facade={listFacade(project, {
        list: async () => [],
        register,
        listAgentCandidates: async () => [
          { id: "codex-cli", label: "OpenAI · Codex CLI", available: true },
          { id: "claude-code", label: "anthropic · anthropic.claude-code", available: true },
        ],
        previewDirectory,
      })} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "注册项目" }));
  await user.click(screen.getByRole("button", { name: "选择项目目录" }));

  expect(await screen.findByText("C:/Projects/Aurora/.claude/skills")).toBeVisible();
  expect(screen.getByText("research")).toBeVisible();
  expect(screen.getByText("预览仅读取目录，不会创建项目、导入 Skill 或写入任何文件。")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "anthropic · anthropic.claude-code" })).toBeChecked();

  await user.click(screen.getByRole("button", { name: "确认注册" }));

  expect(previewDirectory).toHaveBeenCalledWith("C:/Projects/Aurora");
  expect(register).toHaveBeenCalledTimes(1);
  expect(register).toHaveBeenCalledWith(expect.objectContaining({
    path: "C:/Projects/Aurora",
    agentIds: ["claude-code"],
  }));
});

it("orders preview skill candidates by agent trace affinity and explains the order on hover", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const previewDirectory = vi.fn(async () => ({
    path: "C:/Projects/Aurora",
    agentTraces: [{
      targetId: "anthropic:claude-code:project:C:/Projects/Aurora/.claude/skills",
      label: "anthropic · anthropic.claude-code",
      path: "C:/Projects/Aurora/.claude/skills",
      marker: "SKILL.md",
      available: true,
    }],
    skillCandidates: [
      { name: "docs-skill", path: "C:/Projects/Aurora/docs/docs-skill" },
      { name: "research", path: "C:/Projects/Aurora/.claude/skills/research" },
      { name: "elsewhere", path: "D:/Other/elsewhere" },
    ],
  }));
  const directoryPicker: DirectoryPicker = { pickDirectory: vi.fn(async () => "C:/Projects/Aurora") };
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage directoryPicker={directoryPicker} facade={listFacade(project, {
        list: async () => [],
        previewDirectory,
      })} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "注册项目" }));
  await user.click(screen.getByRole("button", { name: "选择项目目录" }));

  const skillList = await screen.findByRole("list", { name: "可扫描的项目 Skill（不会自动导入）" });
  expect(within(skillList).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "researchC:/Projects/Aurora/.claude/skills/research",
    "docs-skillC:/Projects/Aurora/docs/docs-skill",
    "elsewhereD:/Other/elsewhere",
  ]);
  expect(screen.getByTitle("与已发现 Agent 目录同前缀或同根的候选排在前面，其余保持原有顺序。")).toBeInTheDocument();
});

it("blocks registration when the directory cannot be previewed", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const register = vi.fn(async () => project);
  const directoryPicker: DirectoryPicker = { pickDirectory: vi.fn(async () => "C:/Projects/Gone") };
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage directoryPicker={directoryPicker} facade={listFacade(project, {
        list: async () => [],
        register,
        previewDirectory: vi.fn(async () => { throw new Error("unreadable"); }),
      })} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "注册项目" }));
  await user.click(screen.getByRole("button", { name: "选择项目目录" }));

  expect(await screen.findByText("无法读取所选目录，请确认路径存在且可访问。")).toBeVisible();
  expect(screen.getByRole("button", { name: "确认注册" })).toBeDisabled();
  expect(register).not.toHaveBeenCalled();
});

it("registers only once when the confirm button is activated repeatedly", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const register = vi.fn(async () => { await gate; return project; });
  const directoryPicker: DirectoryPicker = { pickDirectory: vi.fn(async () => "C:/Projects/Aurora") };
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage directoryPicker={directoryPicker} facade={listFacade(project, {
        list: async () => [],
        register,
        previewDirectory: async () => ({ path: "C:/Projects/Aurora", agentTraces: [], skillCandidates: [] }),
      })} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "注册项目" }));
  await user.click(screen.getByRole("button", { name: "选择项目目录" }));
  await screen.findByText("未发现可扫描的 Skill 目录。");

  const confirm = screen.getByRole("button", { name: "确认注册" });
  confirm.click();
  confirm.click();
  release();
  await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
  expect(register).toHaveBeenCalledTimes(1);
});

const accessibleTarget = { id: "fs:demo-project", path: "D:/Work/demo", exists: true, readable: true, writable: true };

it("reports the project directory access state from the discovery snapshot on each card", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={listFacade(project, {
        listPhysicalTargets: async () => [
          { ...accessibleTarget, exists: false, readable: false, writable: false },
        ],
      })} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("不可访问")).toBeVisible();
  expect(screen.getByText("Demo Project")).toBeVisible();
});

it("marks the access state unknown when the discovery snapshot cannot be read", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={listFacade(project, {
        listPhysicalTargets: vi.fn(async () => { throw new Error("snapshot unavailable"); }),
      })} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("未知")).toBeVisible();
});

it("shows the associated Agent count from the listed project facts", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = { ...projectFixture(), agentIds: ["codex-cli", "claude-code"] };
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={listFacade(project)} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("关联 Agent：2")).toBeVisible();
});

it("suggests resolving assembly conflicts and opens the project details from the next step", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const onOpenProject = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={listFacade(project, {
        getAssemblyPlan: async () => ({
          items: [
            { name: "Release Notes", reasons: ["同名冲突"], skillId: "release-notes", status: "conflict_needs_choice" },
            { name: "PDF Reader", reasons: [], skillId: "pdf-reader", status: "already_satisfied" },
          ],
        }),
        listPhysicalTargets: async () => [accessibleTarget],
      })} onOpenProject={onOpenProject} />
    </I18nextProvider>,
  );

  const resolve = await screen.findByRole("button", { name: "处理装配冲突（1 项）" });
  await user.click(resolve);
  expect(onOpenProject).toHaveBeenCalledWith("demo-project");
  expect(screen.queryByText("检查目录权限")).not.toBeInTheDocument();
});

it("points projects without an assembly plan at declaring shared requirements", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={listFacade(project, {
        listPhysicalTargets: async () => [accessibleTarget],
      })} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("在项目详情声明共享配置需求")).toBeVisible();
});

it("asks to check directory access first when the registered path is unreachable", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={listFacade(project, {
        getAssemblyPlan: async () => ({
          items: [
            { name: "Release Notes", reasons: ["同名冲突"], skillId: "release-notes", status: "conflict_needs_choice" },
          ],
        }),
        listPhysicalTargets: async () => [
          { ...accessibleTarget, exists: false, readable: false, writable: false },
        ],
      })} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("检查目录权限")).toBeVisible();
  expect(screen.queryByText(/处理装配冲突/)).not.toBeInTheDocument();
});

it("keeps the quick drawer access and next-step facts on the same source as the card", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = { ...projectFixture(), agentIds: ["codex-cli"] };
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectListPage facade={listFacade(project, {
        listPhysicalTargets: async () => [accessibleTarget],
      })} />
    </I18nextProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "Demo Project" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("可访问")).toBeVisible();
  expect(within(dialog).getByText("关联 Agent：1")).toBeVisible();
  expect(within(dialog).getByText("在项目详情声明共享配置需求")).toBeVisible();
});
