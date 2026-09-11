import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { projectFixture, type ProjectFacade, type ProjectView } from "./api";
import { ProjectQuickDrawer } from "./ProjectQuickDrawer";

function drawerFacade(project: ProjectView, overrides: Partial<ProjectFacade> = {}): ProjectFacade {
  return {
    get: async () => project,
    list: async () => [project],
    register: async () => project,
    updateAgentIds: async () => project,
    setTags: async () => project,
    updateDetails: async () => project,
    listAgentCandidates: async () => [],
    previewDirectory: async () => ({ path: "", agentTraces: [], skillCandidates: [] }),
    getAssemblyPlan: async () => null,
    listPhysicalTargets: async () => [],
    ...overrides,
  };
}

it("keeps the drawer read-only and offers edit only with a facade", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  const { rerender } = render(
    <I18nextProvider i18n={i18n}>
      <ProjectQuickDrawer onClose={() => {}} open project={project} />
    </I18nextProvider>,
  );
  expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();

  rerender(
    <I18nextProvider i18n={i18n}>
      <ProjectQuickDrawer facade={drawerFacade(project)} onClose={() => {}} open project={project} />
    </I18nextProvider>,
  );
  expect(screen.getByRole("button", { name: "编辑" })).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "项目名称" })).not.toBeInTheDocument();
});

it("saves edited name, note, and tags and reports the updated project", async () => {
  const user = userEvent.setup();
  const project = projectFixture();
  const renamed = { ...project, name: "Aurora", description: "Renamed workspace" };
  const retagged = { ...renamed, tags: ["Aurora", "Rust"] };
  const updateDetails = vi.fn(async () => renamed);
  const setTags = vi.fn(async () => retagged);
  const onProjectChanged = vi.fn();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectQuickDrawer
        facade={{ ...drawerFacade(project), setTags, updateDetails }}
        onClose={() => {}}
        onOpenProject={vi.fn()}
        onProjectChanged={onProjectChanged}
        open
        project={project}
      />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("button", { name: "编辑" }));
  const name = screen.getByRole("textbox", { name: "项目名称" });
  expect(name).toHaveValue("Demo Project");
  await user.clear(name);
  await user.type(name, "Aurora");
  const note = screen.getByRole("textbox", { name: "备注" });
  expect(note).toHaveValue("用于验证项目级 Skill 组合的示例项目");
  await user.clear(note);
  await user.type(note, "Renamed workspace");
  const tags = screen.getByRole("textbox", { name: "标签" });
  expect(tags).toHaveValue("客户项目, Rust, 演示");
  await user.clear(tags);
  await user.type(tags, "Aurora, Rust");

  await user.click(screen.getByRole("button", { name: "保存" }));

  expect(updateDetails).toHaveBeenCalledWith("demo-project", { name: "Aurora", note: "Renamed workspace" });
  expect(setTags).toHaveBeenCalledWith("demo-project", ["Aurora", "Rust"]);
  expect(onProjectChanged).toHaveBeenCalledWith(retagged);
  expect(await screen.findByText("已保存项目信息。")).toBeVisible();
  expect(screen.getByRole("button", { name: "管理项目" })).toBeVisible();
});

it("keeps the edit form open with the native error code when details cannot be saved", async () => {
  const user = userEvent.setup();
  const project = projectFixture();
  const updateDetails = vi.fn(async () => { throw { code: "database.locked" }; });
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectQuickDrawer facade={{ ...drawerFacade(project), updateDetails }} onClose={() => {}} open project={project} />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByText("无法保存项目信息（database.locked）。")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "项目名称" })).toBeVisible();
});

it("reports a partial success when details save but tags do not", async () => {
  const user = userEvent.setup();
  const project = projectFixture();
  const setTags = vi.fn(async () => { throw { code: "database.locked" }; });
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectQuickDrawer facade={{ ...drawerFacade(project), setTags }} onClose={() => {}} open project={project} />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.type(screen.getByRole("textbox", { name: "标签" }), "Aurora");
  await user.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByText("项目信息已保存，但标签保存失败（database.locked）。")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "标签" })).toBeVisible();
});

it("cancels an edit without writing anything", async () => {
  const user = userEvent.setup();
  const project = projectFixture();
  const updateDetails = vi.fn(async () => project);
  const setTags = vi.fn(async () => project);
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectQuickDrawer facade={{ ...drawerFacade(project), setTags, updateDetails }} onClose={() => {}} onOpenProject={vi.fn()} open project={project} />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.click(screen.getByRole("button", { name: "取消" }));

  expect(updateDetails).not.toHaveBeenCalled();
  expect(setTags).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "管理项目" })).toBeVisible();
});

it("still shows the same-source access and next-step facts", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const project = projectFixture();
  render(
    <I18nextProvider i18n={i18n}>
      <ProjectQuickDrawer
        accessState="read_only"
        nextStep={{ conflicts: 2, kind: "resolve_conflicts" }}
        onClose={() => {}}
        open
        project={project}
      />
    </I18nextProvider>,
  );

  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("只读")).toBeVisible();
  expect(within(dialog).getByText("处理装配冲突（2 项）")).toBeVisible();
});
