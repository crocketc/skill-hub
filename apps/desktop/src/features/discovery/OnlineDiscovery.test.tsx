import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { DownloadedRepoSkill, SourceSearchPage } from "../../api/bindings";
import { OnlineDiscovery, parseGitHubRepoTree, toRepoSkill } from "./OnlineDiscovery";
import type { DiscoveryFacade } from "./api";

const hit = {
  source_id: "skills.sh/anthropics/skills/pdf",
  name: "PDF Reader",
  source: {
    kind: "https" as const,
    locator: { https_url: "https://github.com/anthropics/skills/tree/main/pdf" },
  },
  install_url: null,
  page_url: "https://skills.sh/anthropics/skills/pdf",
  installs: 42,
  is_duplicate: false,
};

const page: SourceSearchPage = {
  items: [hit],
  query: "pdf",
  count: 1,
  search_type: "skills",
  duration_ms: 12,
  cache_max_age_seconds: null,
};

function baseFacade(overrides: Partial<DiscoveryFacade> = {}): DiscoveryFacade {
  return {
    getDiscoverySnapshot: async () => {
      throw new Error("not used");
    },
    scanTargets: async () => {
      throw new Error("not used");
    },
    searchOnlineSources: vi.fn(async () => page),
    listSkillRepos: async () => [],
    discoverRepoSkills: async () => ({ skills: [], warnings: [] }),
    discoverAgentsLockSkills: async () => [],
    addSkillRepo: async () => [],
    removeSkillRepo: async () => [],
    downloadRepoSkill: vi.fn(async (): Promise<DownloadedRepoSkill> => ({
      local_path: "C:/temp/skillhub-repo-skills/1/pdf",
      runtime_name: "pdf",
    })),
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
  const instance = (globalThis as { __skillhubOnlineDiscoveryI18n?: Awaited<ReturnType<typeof createSkillHubI18n>> })
    .__skillhubOnlineDiscoveryI18n;
  if (instance) return instance;
  throw new Error("i18n instance not initialized");
}

beforeAll(async () => {
  (globalThis as { __skillhubOnlineDiscoveryI18n?: Awaited<ReturnType<typeof createSkillHubI18n>> })
    .__skillhubOnlineDiscoveryI18n = await createSkillHubI18n(["zh-CN"]);
});

async function renderSearched(facade: DiscoveryFacade, onImportDirectory = vi.fn(), importedNames?: () => Promise<string[]>) {
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <OnlineDiscovery
        facade={facade}
        importedNames={importedNames}
        onImportDirectory={onImportDirectory}
        onStartImport={vi.fn()}
      />
    </I18nextProvider>,
  );
  fireEvent.change(screen.getByLabelText("搜索 skills.sh"), { target: { value: "pdf" } });
  await click(screen.getByRole("button", { name: "搜索" }));
  await screen.findByText("PDF Reader");
  return onImportDirectory;
}

it("guides the user with a visible hint before the first search", () => {
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <OnlineDiscovery
        facade={baseFacade()}
        onImportDirectory={vi.fn()}
        onStartImport={vi.fn()}
      />
    </I18nextProvider>,
  );

  expect(screen.getByRole("status")).toHaveTextContent("输入关键词后搜索 skills.sh");
});

it("renders view and install actions for each online search hit", async () => {
  await renderSearched(baseFacade());

  expect(screen.getByRole("link", { name: "查看" })).toBeVisible();
  expect(screen.getByRole("button", { name: "安装导入" })).toBeVisible();
  expect(screen.getByText("来源：skills.sh")).toBeVisible();
  expect(screen.getByText("安装次数：42")).toBeVisible();
});

it("renders each online hit as a shared skill card with honest metadata", async () => {
  await renderSearched(baseFacade());

  const title = screen.getByRole("heading", { name: "PDF Reader" });
  const card = title.closest("article");
  expect(card).not.toBeNull();
  const scope = within(card as HTMLElement);
  expect(scope.getByText("来源：skills.sh")).toBeVisible();
  expect(scope.getByText("安装次数：42")).toBeVisible();
  // 标题、链接与操作保持独立语义：链接和按钮在卡片内，但卡片本身不是按钮。
  expect(scope.getByRole("link", { name: "查看" })).toBeVisible();
  expect(scope.getByRole("button", { name: "安装导入" })).toBeVisible();
});

it("marks hits without a usable GitHub source as honestly not installable", async () => {
  const localHit = {
    ...hit,
    source_id: "local/unknown",
    source: { kind: "local" as const, locator: { local_path: "C:/skills/pdf" } },
  };
  const localPage: SourceSearchPage = { ...page, items: [localHit], count: 1 };
  await renderSearched(
    baseFacade({ searchOnlineSources: vi.fn(async () => localPage) }),
  );

  expect(screen.getByText("不可安装")).toBeVisible();
  expect(screen.getByRole("button", { name: "安装导入" })).toBeDisabled();
});

it("opens the result page in the platform browser after explicit confirmation", async () => {
  const openExternalUrl = vi.fn(async () => {});
  await renderSearched(baseFacade({ openExternalUrl }));

  await click(screen.getByRole("link", { name: "查看" }));
  await click(await screen.findByRole("button", { name: "打开链接" }));

  expect(openExternalUrl).toHaveBeenCalledWith("https://skills.sh/anthropics/skills/pdf");
});

it("downloads the hit repository and hands the local directory to the import wizard", async () => {
  const downloadRepoSkill = vi.fn(async (): Promise<DownloadedRepoSkill> => ({
    local_path: "C:/temp/skillhub-repo-skills/1/pdf",
    runtime_name: "pdf",
  }));
  const facade = baseFacade({ downloadRepoSkill });
  const onImportDirectory = await renderSearched(facade);

  await click(screen.getByRole("button", { name: "安装导入" }));

  expect(downloadRepoSkill).toHaveBeenCalledWith(
    expect.objectContaining({ repo_owner: "anthropics", repo_name: "skills" }),
  );
  await waitFor(() =>
    expect(onImportDirectory).toHaveBeenCalledWith("C:/temp/skillhub-repo-skills/1/pdf"),
  );
});

it("disables the install action and shows download progress while installing", async () => {
  let resolveDownload!: (value: DownloadedRepoSkill) => void;
  const downloadRepoSkill = vi.fn(
    () =>
      new Promise<DownloadedRepoSkill>((resolve) => {
        resolveDownload = resolve;
      }),
  );
  const onImportDirectory = await renderSearched(baseFacade({ downloadRepoSkill }));

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "安装导入" }));
    await Promise.resolve();
  });

  const installing = screen.getByRole("button", { name: "下载中…" });
  expect(installing).toBeDisabled();
  expect(onImportDirectory).not.toHaveBeenCalled();

  await act(async () => {
    resolveDownload({ local_path: "C:/temp/skillhub-repo-skills/1/pdf", runtime_name: "pdf" });
    await Promise.resolve();
  });

  await waitFor(() =>
    expect(onImportDirectory).toHaveBeenCalledWith("C:/temp/skillhub-repo-skills/1/pdf"),
  );
});

it("keeps the structured error code visible when the download fails", async () => {
  const downloadRepoSkill = vi.fn(async (): Promise<DownloadedRepoSkill> => {
    throw { code: "repo.archive_unavailable", severity: "error", params: {}, actions: [] };
  });
  const onImportDirectory = await renderSearched(baseFacade({ downloadRepoSkill }));

  await click(screen.getByRole("button", { name: "安装导入" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("repo.archive_unavailable");
  expect(onImportDirectory).not.toHaveBeenCalled();
});

it("falls back to the install-failed message for opaque download errors", async () => {
  const downloadRepoSkill = vi.fn(async (): Promise<DownloadedRepoSkill> => {
    throw "download interrupted";
  });
  await renderSearched(baseFacade({ downloadRepoSkill }));

  await click(screen.getByRole("button", { name: "安装导入" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("安装失败（unknown），请稍后重试。");
});

it("disables install for hits without a recognizable GitHub source", async () => {
  const localHit = {
    ...hit,
    source_id: "local/unknown",
    source: { kind: "local" as const, locator: { local_path: "C:/skills/pdf" } },
  };
  const localPage: SourceSearchPage = { ...page, items: [localHit], count: 1 };
  const downloadRepoSkill = vi.fn(async (): Promise<DownloadedRepoSkill> => ({
    local_path: "C:/temp/x",
    runtime_name: "x",
  }));
  await renderSearched(baseFacade({ downloadRepoSkill, searchOnlineSources: vi.fn(async () => localPage) }));

  const install = screen.getByRole("button", { name: "安装导入" });
  expect(install).toBeDisabled();
  await click(install);
  expect(downloadRepoSkill).not.toHaveBeenCalled();
});

it("marks hits whose name already exists in the library and disables their install", async () => {
  const downloadRepoSkill = vi.fn(async (): Promise<DownloadedRepoSkill> => ({
    local_path: "C:/temp/x",
    runtime_name: "x",
  }));
  await renderSearched(
    baseFacade({ downloadRepoSkill }),
    vi.fn(),
    async () => ["pdf reader"],
  );

  expect(await screen.findByText("同名 Skill 已在库中")).toBeVisible();
  expect(screen.getByRole("button", { name: "安装导入" })).toBeDisabled();
  await click(screen.getByRole("button", { name: "安装导入" }));
  expect(downloadRepoSkill).not.toHaveBeenCalled();
});

it("shows an honest empty state when the search returns no hits", async () => {
  const emptyPage: SourceSearchPage = { ...page, items: [], count: 0 };
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <OnlineDiscovery
        facade={baseFacade({ searchOnlineSources: vi.fn(async () => emptyPage) })}
        onImportDirectory={vi.fn()}
        onStartImport={vi.fn()}
      />
    </I18nextProvider>,
  );
  fireEvent.change(screen.getByLabelText("搜索 skills.sh"), { target: { value: "pdf" } });
  await click(screen.getByRole("button", { name: "搜索" }));

  expect(await screen.findByText("没有匹配的结果。")).toBeVisible();
  expect(screen.queryByRole("button", { name: "安装导入" })).not.toBeInTheDocument();
});

it("announces the searching state while the query is in flight", async () => {
  let resolveSearch!: (value: SourceSearchPage) => void;
  const searchOnlineSources = vi.fn(
    () => new Promise<SourceSearchPage>((resolve) => { resolveSearch = resolve; }),
  );
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <OnlineDiscovery
        facade={baseFacade({ searchOnlineSources })}
        onImportDirectory={vi.fn()}
        onStartImport={vi.fn()}
      />
    </I18nextProvider>,
  );
  fireEvent.change(screen.getByLabelText("搜索 skills.sh"), { target: { value: "pdf" } });
  await click(screen.getByRole("button", { name: "搜索" }));

  expect(screen.getByRole("status")).toHaveTextContent("正在搜索…");
  resolveSearch(page);
  await screen.findByText("PDF Reader");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

describe("single-skill install (P1-04)", () => {
  it("parses branch and directory from GitHub tree URLs", () => {
    expect(parseGitHubRepoTree(["https://github.com/anthropics/skills/tree/main/pdf"]))
      .toEqual({ branch: "main", directory: "pdf" });
    expect(parseGitHubRepoTree(["https://github.com/anthropics/skills/tree/main/deep/nested/tool"]))
      .toEqual({ branch: "main", directory: "deep/nested/tool" });
    // 只有分支没有目录：整仓但钉住分支。
    expect(parseGitHubRepoTree(["https://github.com/anthropics/skills/tree/main"]))
      .toEqual({ branch: "main", directory: "" });
    // 查询串/锚点与尾斜杠不破坏解析。
    expect(parseGitHubRepoTree(["https://github.com/a/b/tree/main/pdf?tab=readme#x"]))
      .toEqual({ branch: "main", directory: "pdf" });
    expect(parseGitHubRepoTree(["https://github.com/a/b/tree/main/pdf/"]))
      .toEqual({ branch: "main", directory: "pdf" });
    // 非 tree 形态与缺失输入返回 null。
    expect(parseGitHubRepoTree(["https://github.com/anthropics/skills"])).toBeNull();
    expect(parseGitHubRepoTree([null, undefined, ""])).toBeNull();
    // 依序兜底：locator 缺失时用 install_url/page_url。
    expect(parseGitHubRepoTree([null, "https://github.com/a/b/tree/dev/x"]))
      .toEqual({ branch: "dev", directory: "x" });
  });

  it("stages only the referenced skill directory with its branch for download", () => {
    const skill = toRepoSkill(hit);
    expect(skill).not.toBeNull();
    expect(skill).toMatchObject({
      key: "anthropics/skills:pdf",
      directory: "pdf",
      repo_branch: "main",
      repo_owner: "anthropics",
      repo_name: "skills",
    });
  });

  it("keeps an unparseable whole-repo install explicit with a visible status", async () => {
    const wholeHit = {
      ...hit,
      source_id: "skills.sh/whole/repo",
      source: {
        kind: "https" as const,
        locator: { https_url: "https://github.com/anthropics/skills" },
      },
    };
    const wholePage: SourceSearchPage = { ...page, items: [wholeHit], count: 1 };
    const downloadRepoSkill = vi.fn(async (): Promise<DownloadedRepoSkill> => ({
      local_path: "C:/temp/skillhub-repo-skills/1/whole",
      runtime_name: "skills",
    }));
    await renderSearched(
      baseFacade({ downloadRepoSkill, searchOnlineSources: vi.fn(async () => wholePage) }),
    );

    // 不静默：整仓导入必须有可见状态徽标。
    expect(await screen.findByText("将导入整仓")).toBeVisible();
    const install = screen.getByRole("button", { name: "安装导入" });
    expect(install).toBeEnabled();
    await click(install);
    expect(downloadRepoSkill).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "", repo_branch: "" }),
    );
  });
});

describe("AI search assist", () => {
  async function toggleAssist() {
    await click(screen.getByLabelText("AI 搜索辅助"));
  }

  it("keeps calling the plain search while the assist toggle is off", async () => {
    const facade = baseFacade();
    await renderSearched(facade);

    expect(facade.searchOnlineSources).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("AI 搜索辅助")).toBeVisible();
  });

  it("marks AI-extended hits and explains the expanded query", async () => {
    const assistedPage: SourceSearchPage = {
      items: [
        hit,
        {
          ...hit,
          source_id: "skills.sh/example/expanded",
          name: "PDF Text Extractor",
          via: "expanded_query",
        },
      ],
      query: "pdf",
      count: 2,
      search_type: "skills",
      duration_ms: 15,
      cache_max_age_seconds: null,
      ai_assisted: true,
      expanded_query: "pdf extraction",
    };
    const assisted = vi.fn(async () => assistedPage);
    const facade = baseFacade({ searchOnlineSourcesAssisted: assisted });
    await renderSearched(facade);
    await toggleAssist();
    await click(screen.getByRole("button", { name: "搜索" }));

    await screen.findByText("PDF Text Extractor");
    expect(
      screen.getByText(/AI 扩展查询“pdf extraction”新增 1 条命中/),
    ).toBeVisible();
    expect(screen.getByTestId("assist-skills.sh/example/expanded")).toBeVisible();
    expect(assisted).toHaveBeenCalledWith("pdf");
  });

  it("falls back to the plain search with a readable reason when the assist fails", async () => {
    const assisted = vi.fn(async () => {
      throw new Error("llm.request_timeout");
    });
    const facade = baseFacade({ searchOnlineSourcesAssisted: assisted });
    await renderSearched(facade);
    await toggleAssist();
    await click(screen.getByRole("button", { name: "搜索" }));

    await screen.findByText("PDF Reader");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("AI 搜索失败，已回退普通搜索；以下结果仍然可用。");
    expect(status).toHaveTextContent("失败原因：连接模型服务超时，请检查网络后重试。");
    expect(status.textContent).not.toContain("llm.request_timeout");
    expect(facade.searchOnlineSources).toHaveBeenCalledTimes(2);
  });

  it("explains the unconfigured fallback when the assistant has no usable provider", async () => {
    const assisted = vi.fn(async () => {
      throw { code: "llm.not_configured", severity: "error", params: {}, actions: [] };
    });
    const facade = baseFacade({ searchOnlineSourcesAssisted: assisted });
    await renderSearched(facade);
    await toggleAssist();
    await click(screen.getByRole("button", { name: "搜索" }));

    expect(await screen.findByText("PDF Reader")).toBeVisible();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("AI 搜索助手尚未配置或凭据不可用，本次已使用普通搜索；以下结果仍然可用。");
    expect(facade.searchOnlineSources).toHaveBeenCalledTimes(2);
  });

  it("announces the cancelled assist separately and keeps the plain results usable", async () => {
    const assisted = vi.fn(async () => {
      throw { code: "llm.cancelled", severity: "error", params: {}, actions: [] };
    });
    const facade = baseFacade({ searchOnlineSourcesAssisted: assisted });
    await renderSearched(facade);
    await toggleAssist();
    await click(screen.getByRole("button", { name: "搜索" }));

    expect(await screen.findByText("PDF Reader")).toBeVisible();
    expect(
      screen.getByText("AI 搜索已取消，已回退普通搜索；以下结果仍然可用。"),
    ).toBeVisible();
    expect(facade.searchOnlineSources).toHaveBeenCalledTimes(2);
  });

  it("classifies plain search failures with the native error copy instead of a generic line", async () => {
    const facade = baseFacade({
      searchOnlineSources: vi.fn(async () => {
        throw { code: "network.disabled", severity: "error", params: {}, actions: [] };
      }),
    });
    render(
      <I18nextProvider i18n={createSkillHubI18nSync()}>
        <OnlineDiscovery
          facade={facade}
          onImportDirectory={vi.fn()}
          onStartImport={vi.fn()}
        />
      </I18nextProvider>,
    );
    fireEvent.change(screen.getByLabelText("搜索 skills.sh"), { target: { value: "pdf" } });
    await click(screen.getByRole("button", { name: "搜索" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("网络功能已关闭；需要在设置中开启后才能联网操作。");
    expect(alert.textContent).not.toContain("network.disabled");
    expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
  });
});
