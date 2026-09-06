import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { AgentsLockEntry } from "../../api/bindings";
import { AgentsLockDiscovery, type AgentsLockFacade } from "./AgentsLockDiscovery";

const entries: AgentsLockEntry[] = [
  {
    name: "pdf",
    owner: "anthropics",
    repo: "skills",
    branch: "v2",
    skill_path: "skills/pdf",
  },
  {
    name: "whole-repo",
    owner: "octo",
    repo: "whole",
    branch: null,
    skill_path: null,
  },
];

function makeFacade(overrides: Partial<AgentsLockFacade> = {}): AgentsLockFacade {
  return {
    discoverAgentsLockSkills: async () => entries,
    downloadRepoSkill: async () => ({
      local_path: "C:/temp/skillhub-repo-skills/1/pdf",
      runtime_name: "pdf",
    }),
    ...overrides,
  };
}

async function renderCard(facade: AgentsLockFacade, onImportDirectory = vi.fn()) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <AgentsLockDiscovery facade={facade} onImportDirectory={onImportDirectory} />
    </I18nextProvider>,
  );
  return onImportDirectory;
}

it("scans the lock file and lists github entries", async () => {
  const user = userEvent.setup();
  const discover = vi.fn(async () => entries);
  await renderCard(makeFacade({ discoverAgentsLockSkills: discover }));

  await user.click(await screen.findByRole("button", { name: "扫描 lock 文件" }));

  expect(await screen.findByText("pdf")).toBeVisible();
  expect(screen.getByText("anthropics/skills@v2")).toBeVisible();
  expect(screen.getByText(/skills\/pdf/)).toBeVisible();
  // 无 skill_path 的整仓条目不显示子目录行
  expect(screen.queryByText(/skillPath/)).not.toBeInTheDocument();
});

it("shows an honest empty state when the lock file is missing or empty", async () => {
  const user = userEvent.setup();
  await renderCard(makeFacade({ discoverAgentsLockSkills: async () => [] }));

  await user.click(await screen.findByRole("button", { name: "扫描 lock 文件" }));
  expect(await screen.findByText(/未发现任何 GitHub 来源/)).toBeVisible();
});

it("hands the downloaded directory to the import wizard with root mapping", async () => {
  const user = userEvent.setup();
  const downloadRepoSkill = vi.fn(async (skill) => {
    // 空 directory = 仓库根整体
    expect(skill.directory).toBe("");
    expect(skill.repo_branch).toBe("");
    return { local_path: "C:/temp/x/whole", runtime_name: "whole" };
  });
  const onImportDirectory = vi.fn();
  await renderCard(makeFacade({ downloadRepoSkill }), onImportDirectory);

  await user.click(await screen.findByRole("button", { name: "扫描 lock 文件" }));
  const buttons = await screen.findAllByRole("button", { name: "下载并导入" });
  await user.click(buttons[buttons.length - 1]);

  await waitFor(() => expect(onImportDirectory).toHaveBeenCalledWith("C:/temp/x/whole"));
});

it("reports scan failures without faking entries", async () => {
  const user = userEvent.setup();
  await renderCard(makeFacade({ discoverAgentsLockSkills: async () => { throw new Error("no home"); } }));

  await user.click(await screen.findByRole("button", { name: "扫描 lock 文件" }));
  expect(await screen.findByRole("alert")).toBeVisible();
});
