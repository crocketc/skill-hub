import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import type {
  DiscoverableRepoSkill,
  DownloadedRepoSkill,
  RepoDiscoveryReport,
  SkillRepo,
} from "../../api/bindings";
import { RepoDiscovery } from "./RepoDiscovery";
import type { DiscoveryFacade } from "./api";

const defaultRepos: SkillRepo[] = [
  { owner: "anthropics", name: "skills", branch: "main", enabled: true },
  { owner: "cexll", name: "myclaude", branch: "master", enabled: false },
];

const skill: DiscoverableRepoSkill = {
  key: "anthropics/skills:pdf",
  name: "PDF",
  description: "Handle PDF files",
  directory: "pdf",
  readme_url: "https://github.com/anthropics/skills/blob/main/pdf/SKILL.md",
  repo_owner: "anthropics",
  repo_name: "skills",
  repo_branch: "main",
};

const report: RepoDiscoveryReport = {
  skills: [skill],
  warnings: [
    {
      owner: "gone",
      name: "missing",
      reason: "DOWNLOAD_FAILED status=404 Not Found",
    },
  ],
};

function baseFacade(overrides: Partial<DiscoveryFacade> = {}): DiscoveryFacade {
  return {
    getDiscoverySnapshot: async () => {
      throw new Error("not used");
    },
    scanTargets: async () => {
      throw new Error("not used");
    },
    searchOnlineSources: async () => {
      throw new Error("not used");
    },
    listSkillRepos: async () => defaultRepos,
    discoverRepoSkills: async () => report,
    addSkillRepo: async (repo: SkillRepo) => [repo],
    removeSkillRepo: async () => defaultRepos,
    downloadRepoSkill: async (): Promise<DownloadedRepoSkill> => ({
      local_path: "C:/temp/skillhub-repo-skills/1/pdf",
      runtime_name: "pdf",
    }),
    ...overrides,
  };
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

function createSkillHubI18nSync() {
  const instance = (globalThis as { __skillhubRepoDiscoveryI18n?: Awaited<ReturnType<typeof createSkillHubI18n>> })
    .__skillhubRepoDiscoveryI18n;
  if (instance) return instance;
  throw new Error("i18n instance not initialized");
}

beforeAll(async () => {
  (globalThis as { __skillhubRepoDiscoveryI18n?: Awaited<ReturnType<typeof createSkillHubI18n>> })
    .__skillhubRepoDiscoveryI18n = await createSkillHubI18n(["zh-CN"]);
});

function renderCard(facade: DiscoveryFacade, onImportDirectory = vi.fn()) {
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <RepoDiscovery facade={facade} onImportDirectory={onImportDirectory} />
    </I18nextProvider>,
  );
  return onImportDirectory;
}

it("renders the configured repositories with enabled state", async () => {
  const listSkillRepos = vi.fn(async () => defaultRepos);
  renderCard(baseFacade({ listSkillRepos }));

  expect(await screen.findByText("anthropics/skills@main")).toBeVisible();
  expect(screen.getByText("cexll/myclaude@master")).toBeVisible();
  const checkboxes = screen.getAllByRole("checkbox");
  expect(checkboxes[0]).toBeChecked();
  expect(checkboxes[1]).not.toBeChecked();
});

it("discovers skills across repositories and surfaces per-repo warnings", async () => {
  const discoverRepoSkills = vi.fn(async () => report);
  renderCard(baseFacade({ discoverRepoSkills }));

  await click(await screen.findByRole("button", { name: "扫描仓库" }));

  await waitFor(() => expect(screen.getByText("PDF")).toBeVisible());
  expect(screen.getByText("Handle PDF files")).toBeVisible();
  const readme = screen.getByRole("link", { name: "README" });
  expect(readme.getAttribute("href")).toBe(
    "https://github.com/anthropics/skills/blob/main/pdf/SKILL.md",
  );
  expect(
    screen.getByText(/gone\/missing/),
  ).toBeVisible();
  expect(screen.getByText(/404/)).toBeVisible();
  expect(discoverRepoSkills).toHaveBeenCalled();
});

it("downloads a discovered skill and hands the local path to the import wizard", async () => {
  const downloadRepoSkill = vi.fn(async () => ({
    local_path: "C:/temp/skillhub-repo-skills/1/pdf",
    runtime_name: "pdf",
  }) satisfies DownloadedRepoSkill);
  const onImportDirectory = vi.fn();
  renderCard(baseFacade({ downloadRepoSkill }), onImportDirectory);

  await click(await screen.findByRole("button", { name: "扫描仓库" }));
  await click(await screen.findByRole("button", { name: "下载并导入" }));

  expect(downloadRepoSkill).toHaveBeenCalledWith(skill);
  await waitFor(() =>
    expect(onImportDirectory).toHaveBeenCalledWith("C:/temp/skillhub-repo-skills/1/pdf"),
  );
});

it("adds a repository through the facade and refreshes the list", async () => {
  const addSkillRepo = vi.fn(async (repo: SkillRepo) => [...defaultRepos, repo]);
  renderCard(baseFacade({ addSkillRepo }));

  fireEvent.change(await screen.findByLabelText("所有者"), { target: { value: "octocat" } });
  fireEvent.change(screen.getByLabelText("仓库名"), { target: { value: "skills" } });
  await click(screen.getByRole("button", { name: "添加仓库" }));

  expect(addSkillRepo).toHaveBeenCalledWith({
    owner: "octocat",
    name: "skills",
    branch: "",
    enabled: true,
  });
  await waitFor(() => expect(screen.getByText("octocat/skills@")).toBeVisible());
});

it("toggles a repository by re-adding it with the flipped enabled flag", async () => {
  const addSkillRepo = vi.fn(async (repo: SkillRepo) => [repo]);
  renderCard(baseFacade({ addSkillRepo }));

  const checkboxes = await screen.findAllByRole("checkbox");
  await click(checkboxes[1]);

  expect(addSkillRepo).toHaveBeenCalledWith({
    owner: "cexll",
    name: "myclaude",
    branch: "master",
    enabled: true,
  });
});

it("removes a repository only after an explicit confirmation", async () => {
  const removeSkillRepo = vi.fn(async () => defaultRepos);
  renderCard(baseFacade({ removeSkillRepo }));

  await screen.findByText("anthropics/skills@main");
  await click(screen.getAllByRole("button", { name: "移除" })[0]);
  expect(removeSkillRepo).not.toHaveBeenCalled();

  await click(await screen.findByRole("button", { name: "确认移除" }));
  expect(removeSkillRepo).toHaveBeenCalledWith("anthropics", "skills");
});
