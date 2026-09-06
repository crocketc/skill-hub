import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { createMockImportFacade } from "../import/api";
import { createOperationTracker } from "../../platform/operationTracker";
import type { DiscoveryFacade } from "./api";
import { DiscoveryPage, type DiscoveryModuleView } from "./DiscoveryPage";

const MODULE_VIEWS: DiscoveryModuleView[] = ["local", "online", "repo", "lock"];

it("renders four fixed discovery module cards on the home page without runtime claims", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage />
    </I18nextProvider>,
  );

  expect(screen.getByRole("heading", { name: "本机发现" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "在线发现" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "仓库发现" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "~/.agents lock" })).toBeVisible();
  expect(screen.getAllByRole("button", { name: /^进入/ })).toHaveLength(4);
  // 主页只承载模块入口；详细搜索、配置、导入按钮全部下沉到子页。
  expect(screen.queryByRole("button", { name: "导入 Skill" })).not.toBeInTheDocument();
  expect(screen.queryByText(/已授权|可用|验证通过/)).not.toBeInTheDocument();
});

it("navigates from each home card to its module subpage", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onNavigate = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage onNavigate={onNavigate} />
    </I18nextProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "进入本机发现" }));
  fireEvent.click(screen.getByRole("button", { name: "进入在线发现" }));
  fireEvent.click(screen.getByRole("button", { name: "进入仓库发现" }));
  fireEvent.click(screen.getByRole("button", { name: "进入~/.agents lock" }));

  expect(onNavigate).toHaveBeenCalledTimes(4);
  expect(onNavigate).toHaveBeenNthCalledWith(1, "local");
  expect(onNavigate).toHaveBeenNthCalledWith(2, "online");
  expect(onNavigate).toHaveBeenNthCalledWith(3, "repo");
  expect(onNavigate).toHaveBeenNthCalledWith(4, "lock");
});

it("returns to the discovery home from each module subpage", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  for (const view of MODULE_VIEWS) {
    const onBack = vi.fn();
    const { unmount } = render(
      <I18nextProvider i18n={i18n}>
        <DiscoveryPage view={view} onBack={onBack} />
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "返回发现主页" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();
  }
});

it("hosts the original module capabilities on their own subpages", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const { unmount } = render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage view="local" />
    </I18nextProvider>,
  );
  expect(screen.getByRole("heading", { name: "本地发现" })).toBeVisible();
  unmount();

  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage view="online" />
    </I18nextProvider>,
  );
  expect(screen.getByRole("heading", { name: "在线发现" })).toBeVisible();
  unmount();

  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage view="repo" discoveryFacade={repoStubFacade()} />
    </I18nextProvider>,
  );
  // 等待子页挂载后的发现快照/仓库列表请求落定，避免 act 警告。
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole("heading", { name: "仓库发现" })).toBeVisible();
  unmount();

  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage view="lock" discoveryFacade={repoStubFacade()} />
    </I18nextProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole("heading", { name: "~/.agents lock 导入" })).toBeVisible();
  unmount();
});

it("demotes the ~/.agents lock card to the last, visually secondary source", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage />
    </I18nextProvider>,
  );

  const lockHeading = screen.getByRole("heading", { name: "~/.agents lock" });
  const lockCard = lockHeading.closest("article");
  expect(lockCard).not.toBeNull();
  expect(lockCard).toHaveClass("sh-discovery-home__card--secondary");
  // 四张卡片中 lock 固定排在最后（次级来源）。
  const cards = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.closest("article"));
  expect(cards[cards.length - 1]).toBe(lockCard);
  expect(screen.getByText(/次级来源：来自/)).toHaveTextContent("skill-lock.json");
});

it("explains the secondary lock source at the top of the lock subpage", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage view="lock" discoveryFacade={repoStubFacade()} />
    </I18nextProvider>,
  );

  expect(screen.getByText(/只读解析，不改动它/)).toBeVisible();
  expect(screen.getByText(/本模块的数据来自/)).toHaveTextContent("skill-lock.json");
});

it("opens the production import wizard without showing mock candidates", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage view="local" />
    </I18nextProvider>,
  );

  fireEvent.click(screen.getAllByRole("button", { name: "导入 Skill" })[0]);

  expect(await screen.findByRole("heading", { name: "导入 Skill" })).toBeVisible();
  expect(screen.queryByText(/导入能力尚未连接/)).not.toBeInTheDocument();
  expect(screen.queryByText("PDF Reader")).not.toBeInTheDocument();
});

it("uses the supplied facade only for the import wizard entry", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  const importFacade = { cancel: vi.fn() } as never;
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage view="local" importFacade={importFacade} />
    </I18nextProvider>,
  );

  expect(screen.getAllByRole("button", { name: "Import Skill" })[0]).toBeVisible();
});

it("reports committed imports and lets the user open the refreshed library", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["en-US"]);
  const onImportComplete = vi.fn();
  const onOpenLibrary = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage
        view="local"
        importFacade={createMockImportFacade({ scenario: "safe-local" })}
        onImportComplete={onImportComplete}
        onOpenLibrary={onOpenLibrary}
      />
    </I18nextProvider>,
  );

  await user.click(screen.getAllByRole("button", { name: "Import Skill" })[0]);
  await user.type(screen.getByLabelText("Source"), "C:\\Skills");
  await user.click(screen.getByRole("button", { name: "Parse source" }));
  await user.click(await screen.findByRole("button", { name: "Continue to candidate selection" }));
  await user.click(screen.getByRole("checkbox", { name: /PDF/ }));
  await user.click(screen.getByRole("button", { name: "Analyze conflicts" }));
  await user.click(await screen.findByRole("button", { name: "Commit import" }));

  expect(onImportComplete).toHaveBeenCalledWith([
    expect.objectContaining({ status: "succeeded" }),
  ]);
  await user.click(await screen.findByRole("button", { name: "Open Skill library" }));
  expect(onOpenLibrary).toHaveBeenCalledTimes(1);
});

it("blocks a second import while a background import is already running", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const tracker = createOperationTracker();
  tracker.begin({ kind: "import", label: "批量导入 Skill", total: 2 });
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage view="local" tracker={tracker} />
    </I18nextProvider>,
  );

  fireEvent.click(screen.getAllByRole("button", { name: "导入 Skill" })[0]);

  expect(screen.queryByRole("heading", { name: "导入 Skill" })).not.toBeInTheDocument();
  expect(screen.getByText(/有一个批量导入正在进行，完成后才能开始新的导入/)).toBeVisible();
});

it("opens the guided import flow with the first scanned source prefilled", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage
        view="local"
        initialSources={["C:\\Users\\Test\\.codex\\skills", "C:\\Users\\Test\\.claude\\skills"]}
        initialSourceText={"C:\\Users\\Test\\.codex\\skills"}
      />
    </I18nextProvider>,
  );

  expect(await screen.findByRole("heading", { name: "导入 Skill" })).toBeVisible();
  expect(screen.getByText("初始化扫描发现 2 个来源目录，已默认全部选中，将在同一流程中批量导入。"))
    .toBeVisible();
  expect(screen.getByLabelText("来源")).toHaveValue("C:\\Users\\Test\\.codex\\skills");
});

it("routes an installed online hit into the import wizard on the online subpage", async () => {
  const user = userEvent.setup();
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade = repoStubFacade();
  facade.searchOnlineSources = vi.fn(async () => onlinePage());
  facade.downloadRepoSkill = vi.fn(async () => ({
    local_path: "C:/temp/skillhub-repo-skills/1/pdf",
    runtime_name: "pdf",
  }));
  render(
    <I18nextProvider i18n={i18n}>
      <DiscoveryPage view="online" discoveryFacade={facade} />
    </I18nextProvider>,
  );

  await user.type(screen.getByLabelText("搜索 skills.sh"), "pdf");
  await user.click(screen.getByRole("button", { name: "搜索" }));
  await user.click(await screen.findByRole("button", { name: "安装导入" }));

  expect(await screen.findByRole("heading", { name: "导入 Skill" })).toBeVisible();
  expect(facade.downloadRepoSkill).toHaveBeenCalledWith(
    expect.objectContaining({ repo_owner: "anthropics", repo_name: "skills" }),
  );
});

function onlinePage() {
  return {
    items: [
      {
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
      },
    ],
    query: "pdf",
    count: 1,
    search_type: "skills",
    duration_ms: 12,
    cache_max_age_seconds: null,
  };
}

function repoStubFacade(): DiscoveryFacade {
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
    listSkillRepos: async () => [],
    discoverRepoSkills: async () => ({ skills: [], warnings: [] }),
    discoverAgentsLockSkills: async () => [],
    addSkillRepo: async () => [],
    removeSkillRepo: async () => [],
    downloadRepoSkill: async () => {
      throw new Error("not used");
    },
    openExternalUrl: async () => {},
  };
}
