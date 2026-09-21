import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import type { RepoDiscoveryReport, SkillRepoView } from "../../api/bindings";
import { RepoManagerPage } from "./RepoManagerPage";
import type { DiscoveryFacade } from "./api";

const scannedRecently = new Date(Date.now() - 30_000).toISOString();
const scannedOlder = new Date(Date.now() - 120_000).toISOString();

const defaultViews: SkillRepoView[] = [
  {
    repo: { owner: "anthropics", name: "skills", branch: "main", enabled: true },
    scan: { scanned_at: scannedRecently, ok: true, candidate_count: 3, error: null },
  },
  {
    repo: { owner: "cexll", name: "myclaude", branch: "", enabled: false },
    scan: {
      scanned_at: scannedOlder,
      ok: false,
      candidate_count: 0,
      error: "DOWNLOAD_FAILED status=404 Not Found",
    },
  },
  {
    repo: { owner: "JimLiu", name: "baoyu-skills", branch: "main", enabled: true },
    scan: null,
  },
];

const refreshedReport: RepoDiscoveryReport = {
  skills: [],
  warnings: [],
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
    listSkillRepos: async () => defaultViews,
    discoverRepoSkills: async () => ({ skills: [], warnings: [] }),
    addSkillRepo: async () => defaultViews,
    removeSkillRepo: async () => defaultViews,
    downloadRepoSkill: async () => {
      throw new Error("not used");
    },
    openExternalUrl: vi.fn(async () => {}),
    createIgnoreRule: vi.fn(async () => {}),
    refreshSkillRepo: vi.fn(async () => refreshedReport),
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
  const instance = (globalThis as { __skillhubRepoManagerI18n?: Awaited<ReturnType<typeof createSkillHubI18n>> })
    .__skillhubRepoManagerI18n;
  if (instance) return instance;
  throw new Error("i18n instance not initialized");
}

beforeAll(async () => {
  (globalThis as { __skillhubRepoManagerI18n?: Awaited<ReturnType<typeof createSkillHubI18n>> })
    .__skillhubRepoManagerI18n = await createSkillHubI18n(["zh-CN"]);
});

function renderPage(facade: DiscoveryFacade) {
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <RepoManagerPage facade={facade} />
    </I18nextProvider>,
  );
}

it("renders repositories with branch, scan time, candidate count and failure reason", async () => {
  renderPage(baseFacade());

  expect(await screen.findByText("anthropics/skills")).toBeVisible();
  expect(screen.getByText("JimLiu/baoyu-skills")).toBeVisible();
  // 空分支用“默认分支”哨兵文案而不是露出空串。
  expect(screen.getAllByText("main")).toHaveLength(2);
  expect(screen.getByText("默认分支")).toBeVisible();

  // 最近一次扫描时间、候选数与失败原因（分类文案，不露原始错误串）。
  expect(screen.getAllByText("上次扫描")).toHaveLength(2);
  expect(screen.getByText("30秒钟前")).toBeVisible();
  expect(screen.getByText("3 个候选 Skill")).toBeVisible();
  expect(screen.getByText(/仓库或分支不存在/)).toBeVisible();
  expect(screen.queryByText(/DOWNLOAD_FAILED/)).not.toBeInTheDocument();
  // 从未扫描的仓库如实显示，不伪造扫描结果。
  expect(screen.getByText("从未扫描")).toBeVisible();

  const switches = screen.getAllByRole("switch");
  expect(switches).toHaveLength(3);
  expect(switches[0]).toBeChecked();
  expect(switches[1]).not.toBeChecked();
  expect(switches[2]).toBeChecked();

  // 审查 m1（2026-09-14）：GitHub 外链的可访问名走 openOnGithub 键，
  // 不再只有裸的可见文案 “GitHub”。
  expect(screen.getByRole("link", { name: "在 GitHub 打开 anthropics/skills" })).toBeVisible();
});

it("parses a full GitHub URL into coordinates and submits the add", async () => {
  const addSkillRepo = vi.fn(async () => defaultViews);
  renderPage(baseFacade({ addSkillRepo }));

  const input = await screen.findByLabelText("仓库地址");
  fireEvent.change(input, { target: { value: "https://github.com/octocat/skills/tree/main" } });
  await click(screen.getByRole("button", { name: "添加仓库" }));

  expect(addSkillRepo).toHaveBeenCalledWith({
    owner: "octocat",
    name: "skills",
    branch: "main",
    enabled: true,
  });
});

it("shows an inline error and skips the backend for unparseable addresses", async () => {
  const addSkillRepo = vi.fn(async () => defaultViews);
  renderPage(baseFacade({ addSkillRepo }));

  const input = await screen.findByLabelText("仓库地址");
  fireEvent.change(input, { target: { value: "https://gitlab.com/a/b" } });
  await click(screen.getByRole("button", { name: "添加仓库" }));

  expect(addSkillRepo).not.toHaveBeenCalled();
  expect(await screen.findByRole("alert")).toHaveTextContent("无法识别仓库地址");
});

it("toggles a repository by re-adding it with the flipped enabled flag", async () => {
  const addSkillRepo = vi.fn(async () => defaultViews);
  renderPage(baseFacade({ addSkillRepo }));

  const switches = await screen.findAllByRole("switch");
  await click(switches[1]);

  expect(addSkillRepo).toHaveBeenCalledWith({
    owner: "cexll",
    name: "myclaude",
    branch: "",
    enabled: true,
  });
});

it("removes a repository only after an explicit confirmation", async () => {
  const removeSkillRepo = vi.fn(async () => defaultViews);
  renderPage(baseFacade({ removeSkillRepo }));

  await screen.findByText("anthropics/skills");
  await click(screen.getAllByRole("button", { name: "移除" })[0]);
  expect(removeSkillRepo).not.toHaveBeenCalled();

  await click(await screen.findByRole("button", { name: "确认移除" }));
  expect(removeSkillRepo).toHaveBeenCalledWith("anthropics", "skills");
});

it("refreshes a single repository with a busy state and reloads the kept scan state", async () => {
  let resolveRefresh!: (value: RepoDiscoveryReport) => void;
  const refreshSkillRepo = vi.fn(
    () =>
      new Promise<RepoDiscoveryReport>((resolve) => {
        resolveRefresh = resolve;
      }),
  );
  const refreshedViews: SkillRepoView[] = [
    {
      repo: { owner: "anthropics", name: "skills", branch: "main", enabled: true },
      scan: { scanned_at: new Date().toISOString(), ok: true, candidate_count: 7, error: null },
    },
  ];
  const listSkillRepos = vi
    .fn()
    .mockResolvedValueOnce(defaultViews)
    .mockResolvedValueOnce(refreshedViews);
  renderPage(baseFacade({ listSkillRepos, refreshSkillRepo }));

  // 审查 m2（2026-09-14）：可访问名带仓库坐标（refreshAria），可见文案固定
  // 为“刷新”（refresh 键），两者不再混用同一键。
  const refreshButton = await screen.findByRole("button", { name: "刷新 anthropics/skills" });
  expect(refreshButton).toHaveAccessibleName("刷新 anthropics/skills");
  expect(refreshButton).toHaveTextContent("刷新");
  await click(refreshButton);

  // 刷新进行中：可访问名保持稳定（aria-label 不随文案切换），可见文案切到
  // “正在刷新…”，按钮进入 busy 且不能重复触发。
  expect(refreshSkillRepo).toHaveBeenCalledWith("anthropics", "skills");
  const refreshingButton = screen.getByRole("button", { name: "刷新 anthropics/skills" });
  expect(refreshingButton).toBeDisabled();
  expect(refreshingButton).toHaveTextContent("正在刷新");

  await act(async () => {
    resolveRefresh(refreshedReport);
    await Promise.resolve();
  });

  await waitFor(() => expect(listSkillRepos).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("7 个候选 Skill")).toBeVisible();
});

it("surfaces a readable alert when the per-repo refresh fails", async () => {
  const refreshSkillRepo = vi.fn(async () => {
    throw { code: "network.disabled", severity: "error", params: {}, actions: [] };
  });
  renderPage(baseFacade({ refreshSkillRepo }));

  await click(await screen.findByRole("button", { name: "刷新 anthropics/skills" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("刷新失败");
  expect(alert).toHaveTextContent("网络功能已关闭");
});

it("shows the empty state when no repositories are configured", async () => {
  renderPage(baseFacade({ listSkillRepos: vi.fn(async () => []) }));

  expect(await screen.findByText("暂无仓库，添加后可扫描发现 Skill。")).toBeVisible();
});

it("reloads the list from the backend via the page-level refresh button", async () => {
  const listSkillRepos = vi.fn(async () => defaultViews);
  renderPage(baseFacade({ listSkillRepos }));

  await screen.findByText("anthropics/skills");
  await click(screen.getByRole("button", { name: "刷新列表" }));

  await waitFor(() => expect(listSkillRepos).toHaveBeenCalledTimes(2));
});

// —— 遗留风险清理（2026-09-14）：启停/移除补防抖——在途请求未落定前控件
// 禁用、处理器忽略重入，双击只产生一次调用。 ——

it("keeps the enable switch busy and ignores re-entry while a toggle is in flight", async () => {
  let resolveToggle: (views: SkillRepoView[]) => void = () => {};
  const addSkillRepo = vi.fn(
    () =>
      new Promise<SkillRepoView[]>((resolve) => {
        resolveToggle = resolve;
      }),
  );
  renderPage(baseFacade({ addSkillRepo }));

  const row = (await screen.findByText("anthropics/skills")).closest("li");
  expect(row).not.toBeNull();
  const sw = within(row as HTMLElement).getByRole("switch");

  await click(sw);
  expect(addSkillRepo).toHaveBeenCalledTimes(1);
  expect(sw).toBeDisabled();

  // 在途期间再次点击（disabled 输入不派发事件；处理器层面也须忽略重入）。
  await click(sw);
  expect(addSkillRepo).toHaveBeenCalledTimes(1);

  await act(async () => resolveToggle(defaultViews));
  await waitFor(() => expect(sw).toBeEnabled());
});

it("runs a removal only once even when the confirm action is retried in flight", async () => {
  let resolveRemove: (views: SkillRepoView[]) => void = () => {};
  const removeSkillRepo = vi.fn(
    () =>
      new Promise<SkillRepoView[]>((resolve) => {
        resolveRemove = resolve;
      }),
  );
  renderPage(baseFacade({ removeSkillRepo }));

  // 第一次确认：进入在途（对话框随 Radix Action 关闭）。
  let row = (await screen.findByText("anthropics/skills")).closest("li") as HTMLElement;
  await click(within(row).getByRole("button", { name: "移除" }));
  await click(screen.getByRole("button", { name: "确认移除" }));
  expect(removeSkillRepo).toHaveBeenCalledTimes(1);

  // 在途期间重新打开确认框再确认：守卫忽略重入，确认钮保持禁用。
  row = (screen.getByText("anthropics/skills")).closest("li") as HTMLElement;
  await click(within(row).getByRole("button", { name: "移除" }));
  const confirm = screen.getByRole("button", { name: "确认移除" });
  expect(confirm).toBeDisabled();
  await click(confirm);
  expect(removeSkillRepo).toHaveBeenCalledTimes(1);

  await act(async () => resolveRemove(defaultViews));
  await waitFor(() => expect(removeSkillRepo).toHaveBeenCalledTimes(1));
});
