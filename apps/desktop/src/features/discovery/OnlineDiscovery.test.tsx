import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { DownloadedRepoSkill, SourceSearchPage } from "../../api/bindings";
import { OnlineDiscovery } from "./OnlineDiscovery";
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

async function renderSearched(facade: DiscoveryFacade, onImportDirectory = vi.fn()) {
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <OnlineDiscovery
        facade={facade}
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

it("renders view and install actions for each online search hit", async () => {
  await renderSearched(baseFacade());

  expect(screen.getByRole("link", { name: "查看" })).toBeVisible();
  expect(screen.getByRole("button", { name: "安装导入" })).toBeVisible();
  expect(screen.getByText("来源：skills.sh")).toBeVisible();
  expect(screen.getByText("安装次数：42")).toBeVisible();
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
