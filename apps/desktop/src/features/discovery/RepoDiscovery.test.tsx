import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import type {
  DiscoverableRepoSkill,
  DownloadedRepoSkill,
  RepoDiscoveryReport,
  SkillRepo,
} from "../../api/bindings";
import { RepoDiscovery, describeRepoWarning } from "./RepoDiscovery";
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
    discoverAgentsLockSkills: async () => [],
    addSkillRepo: async (repo: SkillRepo) => [repo],
    removeSkillRepo: async () => defaultRepos,
    downloadRepoSkill: async (): Promise<DownloadedRepoSkill> => ({
      local_path: "C:/temp/skillhub-repo-skills/1/pdf",
      runtime_name: "pdf",
    }),
    openExternalUrl: vi.fn(async () => {}),
    createIgnoreRule: vi.fn(async () => {}),
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
  const openExternalUrl = vi.fn(async () => {});
  renderCard(baseFacade({ discoverRepoSkills, openExternalUrl }));

  await click(await screen.findByRole("button", { name: "扫描仓库" }));

  await waitFor(() => expect(screen.getByText("PDF")).toBeVisible());
  expect(screen.getByText("Handle PDF files")).toBeVisible();
  const readme = screen.getByRole("link", { name: "README" });

  // The README link opens through the native shell after an explicit confirm,
  // never as a raw anchor that the packaged WebView would silently ignore.
  await click(readme);
  const openLink = await screen.findByRole("button", { name: "打开链接" });
  await click(openLink);
  await waitFor(() =>
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/anthropics/skills/blob/main/pdf/SKILL.md",
    ),
  );
  // P1-04：逐仓失败以可读分类文案呈现，仓库名仍然可见。
  expect(screen.getByText(/gone\/missing/)).toBeVisible();
  expect(screen.getByText(/仓库或分支不存在/)).toBeVisible();
  expect(discoverRepoSkills).toHaveBeenCalled();
});

it("maps every warning reason to a readable category and keeps unknown reasons raw", () => {
  expect(describeRepoWarning("DOWNLOAD_FAILED status=404 Not Found", (key) => key))
    .toBe("discovery.repo.warningReason.notFound");
  expect(describeRepoWarning("DOWNLOAD_TIMEOUT after 60s", (key) => key))
    .toBe("discovery.repo.warningReason.timeout");
  expect(describeRepoWarning("NETWORK unreachable", (key) => key))
    .toBe("discovery.repo.warningReason.network");
  // 未分类原因保留原始串，方便诊断，不静默。
  expect(describeRepoWarning("SOMETHING_ELSE", (key, options) => `${key}:${options?.reason}`))
    .toBe("discovery.repo.warningReason.unknown:SOMETHING_ELSE");
});

it("renders warnings as readable categories with a per-repo retry button", async () => {
  const warningReport: RepoDiscoveryReport = {
    skills: [],
    warnings: [
      { owner: "gone", name: "missing", reason: "DOWNLOAD_FAILED status=404 Not Found" },
      { owner: "slow", name: "repo", reason: "DOWNLOAD_TIMEOUT after 60s" },
      { owner: "net", name: "blocked", reason: "NETWORK unreachable" },
    ],
  };
  renderCard(baseFacade({ discoverRepoSkills: vi.fn(async () => warningReport) }));

  await click(await screen.findByRole("button", { name: "扫描仓库" }));

  expect(await screen.findByText(/仓库或分支不存在/)).toBeVisible();
  expect(screen.getByText(/下载超时/)).toBeVisible();
  expect(screen.getByText(/网络未开启或不可达/)).toBeVisible();
  // 已知分类不把后端原始错误串直接展示给用户。
  expect(screen.queryByText(/DOWNLOAD_FAILED/)).not.toBeInTheDocument();
  expect(screen.queryByText(/DOWNLOAD_TIMEOUT/)).not.toBeInTheDocument();
  // 每个失败仓库都有独立重试入口。
  expect(screen.getByRole("button", { name: "重试扫描 gone/missing" })).toBeVisible();
  expect(screen.getByRole("button", { name: "重试扫描 slow/repo" })).toBeVisible();
  expect(screen.getByRole("button", { name: "重试扫描 net/blocked" })).toBeVisible();
});

it("retries only the failed repo row and merges the refreshed result", async () => {
  const failing: RepoDiscoveryReport = {
    skills: [],
    warnings: [{ owner: "gone", name: "missing", reason: "DOWNLOAD_FAILED status=404" }],
  };
  // 第二次整体发现：gone/missing 恢复，产出它自己的 Skill。
  const recoveredSkill: DiscoverableRepoSkill = {
    ...skill,
    key: "gone/missing:pdf",
    repo_owner: "gone",
    repo_name: "missing",
  };
  const recovered: RepoDiscoveryReport = { skills: [recoveredSkill], warnings: [] };
  let calls = 0;
  const discoverRepoSkills = vi.fn(async () => {
    calls += 1;
    return calls === 1 ? failing : recovered;
  });
  renderCard(baseFacade({ discoverRepoSkills }));

  await click(await screen.findByRole("button", { name: "扫描仓库" }));
  expect(await screen.findByText(/仓库或分支不存在/)).toBeVisible();

  await click(screen.getByRole("button", { name: "重试扫描 gone/missing" }));

  expect(discoverRepoSkills).toHaveBeenCalledTimes(2);
  expect(await screen.findByRole("heading", { name: "PDF" })).toBeVisible();
  expect(screen.queryByText(/仓库或分支不存在/)).not.toBeInTheDocument();
});

it("reports a retry failure without discarding the existing report", async () => {
  const failing: RepoDiscoveryReport = {
    skills: [],
    warnings: [{ owner: "gone", name: "missing", reason: "DOWNLOAD_FAILED status=404" }],
  };
  let calls = 0;
  const discoverRepoSkills = vi.fn(async () => {
    calls += 1;
    if (calls === 1) return failing;
    throw { code: "network.disabled", severity: "error", params: {}, actions: [] };
  });
  renderCard(baseFacade({ discoverRepoSkills }));

  await click(await screen.findByRole("button", { name: "扫描仓库" }));
  expect(await screen.findByText(/仓库或分支不存在/)).toBeVisible();

  await click(screen.getByRole("button", { name: "重试扫描 gone/missing" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("网络功能已关闭");
  // 重试失败不清空既有结果。
  expect(screen.getByText(/仓库或分支不存在/)).toBeVisible();
});

it("renders discovered repo skills as shared skill cards", async () => {
  renderCard(baseFacade());

  await click(await screen.findByRole("button", { name: "扫描仓库" }));

  const title = await screen.findByRole("heading", { name: "PDF" });
  const card = title.closest("article");
  expect(card).not.toBeNull();
  const scope = within(card as HTMLElement);
  expect(scope.getByText("anthropics/skills@main")).toBeVisible();
  expect(scope.getByText("Handle PDF files")).toBeVisible();
  expect(scope.getByRole("link", { name: "README" })).toBeVisible();
  expect(scope.getByRole("button", { name: "下载并导入" })).toBeVisible();
});

it("omits the description honestly when a repo skill has none", async () => {
  const noDescription: DiscoverableRepoSkill = { ...skill, description: "" };
  renderCard(
    baseFacade({ discoverRepoSkills: vi.fn(async () => ({ skills: [noDescription], warnings: [] })) }),
  );

  await click(await screen.findByRole("button", { name: "扫描仓库" }));

  expect(await screen.findByRole("heading", { name: "PDF" })).toBeVisible();
  // 仓库归档没有提供描述：卡片省略该区域，而不是伪造“暂无描述”类占位文案。
  expect(screen.queryByText(/暂无描述|暂无说明|No description/)).not.toBeInTheDocument();
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

it("shows elapsed scanning progress while discovering and clears it when the scan finishes", async () => {
  vi.useFakeTimers();
  try {
    let resolveDiscover!: (value: RepoDiscoveryReport) => void;
    const pending = new Promise<RepoDiscoveryReport>((resolve) => {
      resolveDiscover = resolve;
    });
    const discoverRepoSkills = vi.fn(() => pending);
    renderCard(baseFacade({ discoverRepoSkills }));

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "扫描仓库" }));

    const progress = screen.getByRole("status");
    expect(progress).toHaveTextContent("已用时 0 秒");
    expect(progress).toHaveTextContent("正在逐个完整下载已启用的仓库并扫描 Skill");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("已用时 2 秒");
    expect(discoverRepoSkills).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDiscover(report);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.queryByText(/已用时/)).not.toBeInTheDocument();
    expect(screen.getByText("PDF")).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});

it("describes the native reason when the scan fails with a known error code", async () => {
  const discoverRepoSkills = vi.fn(async () => {
    throw { code: "network.disabled", severity: "error", params: {}, actions: [] };
  });
  renderCard(baseFacade({ discoverRepoSkills }));

  await click(await screen.findByRole("button", { name: "扫描仓库" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("网络功能已关闭");
  expect(alert).not.toHaveTextContent("仓库发现失败，请稍后重试。");
});

it("keeps the raw error code visible for unknown scan failures", async () => {
  const discoverRepoSkills = vi.fn(async () => {
    throw { code: "repo.archive_unavailable", severity: "error", params: {}, actions: [] };
  });
  renderCard(baseFacade({ discoverRepoSkills }));

  await click(await screen.findByRole("button", { name: "扫描仓库" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("repo.archive_unavailable");
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
