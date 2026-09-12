import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import type {
  DiscoverySnapshot,
  ScanResult,
  SourceSearchHit,
  SourceSearchPage,
} from "../../api/bindings";
import discoveryCss from "./discovery.css?raw";
import { LocalDiscoveryWorkbench } from "./LocalDiscoveryWorkbench";
import type { SkillRepo } from "../../api/bindings";

const repoDiscoveryStubs = {
  listSkillRepos: async () => [] as SkillRepo[],
  discoverAgentsLockSkills: async () => [] as never[],
  discoverRepoSkills: async () => ({ skills: [], warnings: [] }) as never,
  addSkillRepo: async (repo: SkillRepo) => [repo],
  removeSkillRepo: async () => [] as SkillRepo[],
  downloadRepoSkill: async () => ({ local_path: "", runtime_name: "" }),
  openExternalUrl: async () => {},
  createIgnoreRule: async () => {},
};
import { OnlineDiscovery } from "./OnlineDiscovery";

const snapshot: DiscoverySnapshot = {
  generation: "1",
  observed_at: "1789114968",
  instances: [
    { profile_id: "p", client_id: "codex", kind: "cli", supported_os: [], client_presence: "Unknown" },
  ],
  logical_targets: [
    {
      id: "lt1",
      profile_id: "p",
      client_id: "codex",
      scope: "global",
      path: "C:/codex/skills",
      marker: "SKILL.md",
      precedence: "preferred",
      exists: true,
      readable: true,
      writable: true,
      available: true,
      physical_id: "pt1",
    },
    {
      id: "lt2",
      profile_id: "p",
      client_id: "codex",
      scope: "global",
      path: "C:/conflict/skills",
      marker: "SKILL.md",
      precedence: "preferred",
      exists: true,
      readable: true,
      writable: true,
      available: false,
      physical_id: "pt2",
    },
  ],
  physical_targets: [
    {
      id: "pt1",
      path: "C:/codex/skills",
      exists: true,
      readable: true,
      writable: true,
      case_behavior: "sensitive",
      logical_target_ids: ["lt1"],
    },
  ],
};

const scanResult: ScanResult = {
  generation: { generation: 1, observed_at: 1 },
  roots: ["C:/codex/skills"],
  discovered: [
    {
      root: "C:/codex/skills",
      relative_path: "alpha",
      path: "C:/codex/skills/alpha",
      marker: "SKILL.md",
      marker_size: 1,
      marker_modified_at: 1,
      size: 1,
      latest_modified_at: 1,
      fingerprint: "a",
      metadata_fingerprint: "b",
    },
  ],
  visited_paths: ["C:/codex/skills/alpha"],
  reparsed_count: 0,
  unchanged_count: 0,
  errors: [{ path: "C:/bad/skill", code: "read.failed" }],
};

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

function createSkillHubI18nSync() {
  const instance = (globalThis as { __skillhubDiscoveryI18n?: Awaited<ReturnType<typeof createSkillHubI18n>> }).__skillhubDiscoveryI18n;
  if (instance) return instance;
  throw new Error("i18n instance not initialized");
}

beforeAll(async () => {
  (globalThis as { __skillhubDiscoveryI18n?: Awaited<ReturnType<typeof createSkillHubI18n>> }).__skillhubDiscoveryI18n =
    await createSkillHubI18n(["zh-CN"]);
});

it("shows the last scan time and scope from the discovery snapshot", async () => {
  const getDiscoverySnapshot = vi.fn(async () => snapshot);
  const { container } = render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <LocalDiscoveryWorkbench facade={{ getDiscoverySnapshot, scanTargets: async () => scanResult, searchOnlineSources: async () => searchPage([]), ...repoDiscoveryStubs }} />
    </I18nextProvider>,
  );

  // P1-04：后端 observed_at 是 epoch 秒十进制串，展示必须本地化，
  // 绝不把原始串直接露给用户。
  await screen.findByText("扫描范围：1 个客户端、1 个物理目标");
  const time = container.querySelector("time");
  expect(time).not.toBeNull();
  expect(time).toHaveAttribute("dateTime", "2026-09-11T08:22:48.000Z");
  expect(time!.textContent).toContain("2026");
  expect(time!.textContent).not.toContain("1789114968");
  expect(time!.textContent!.length).toBeGreaterThan(0);
});

it("shows an honest placeholder when the snapshot time cannot be parsed", async () => {
  const brokenSnapshot = { ...snapshot, observed_at: "not-a-timestamp" };
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <LocalDiscoveryWorkbench
        facade={{
          getDiscoverySnapshot: async () => brokenSnapshot,
          scanTargets: async () => scanResult,
          searchOnlineSources: async () => searchPage([]),
          ...repoDiscoveryStubs,
        }}
      />
    </I18nextProvider>,
  );

  expect(await screen.findByText("时间未知")).toBeVisible();
  expect(screen.queryByText("not-a-timestamp")).not.toBeInTheDocument();
});

it("re-scans and classifies results into the five categories", async () => {
  const scanTargets = vi.fn(async () => scanResult);
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <LocalDiscoveryWorkbench facade={{ getDiscoverySnapshot: async () => snapshot, scanTargets, searchOnlineSources: async () => searchPage([]), ...repoDiscoveryStubs }} />
    </I18nextProvider>,
  );

  await click(await screen.findByRole("button", { name: "重新扫描" }));

  expect(scanTargets).toHaveBeenCalledWith([]);
  await waitFor(() => expect(screen.getByText("未纳管 1")).toBeVisible());
  expect(screen.getByText("已关联目录 1")).toBeVisible();
  expect(screen.getByText("冲突 1")).toBeVisible();
  expect(screen.getByText("疑似重复 0")).toBeVisible();
  expect(screen.getByText("无法读取 1")).toBeVisible();
});

it("explains each category through tooltips", async () => {
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <LocalDiscoveryWorkbench facade={{ getDiscoverySnapshot: async () => snapshot, scanTargets: async () => scanResult, searchOnlineSources: async () => searchPage([]), ...repoDiscoveryStubs }} />
    </I18nextProvider>,
  );

  await click(await screen.findByRole("button", { name: "重新扫描" }));
  await waitFor(() => expect(screen.getByText("已关联目录 1")).toBeVisible());

  expect(screen.getByText("已关联目录 1").getAttribute("title")).toContain("客户端");
  expect(screen.getByText("疑似重复 0").getAttribute("title")).toContain("指纹");
});

function searchPage(items: SourceSearchHit[]): SourceSearchPage {
  return {
    items,
    query: "agent",
    count: items.length,
    search_type: "skills.sh",
    duration_ms: 42,
    cache_max_age_seconds: 60,
  };
}

it("searches skills.sh and renders the real source results", async () => {
  const searchOnlineSources = vi.fn(async () => searchPage([
    {
      source_id: "s1",
      name: "Alpha",
      source: { kind: "https", locator: { https_url: "https://skills.sh/alpha" } },
      install_url: "https://skills.sh/alpha/install",
      page_url: "https://skills.sh/alpha",
      installs: 12,
      is_duplicate: false,
    },
  ]));
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <OnlineDiscovery facade={{ getDiscoverySnapshot: async () => snapshot, scanTargets: async () => scanResult, searchOnlineSources, ...repoDiscoveryStubs }} onImportDirectory={() => undefined} onStartImport={() => undefined} />
    </I18nextProvider>,
  );

  const input = screen.getByRole("textbox", { name: "搜索 skills.sh" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "agent" } });
  await click(screen.getByRole("button", { name: "搜索" }));

  expect(searchOnlineSources).toHaveBeenCalledWith({ query: "agent", limit: 20, owner: null });
  expect(await screen.findByText("Alpha")).toBeVisible();
  expect(screen.getByText("来源：skills.sh")).toBeVisible();
  expect(screen.getByText("安装次数：12")).toBeVisible();
});

it("shows a pending-import banner and review entry when unmanaged candidates exist", async () => {
  const onReviewCandidates = vi.fn();
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <LocalDiscoveryWorkbench
        facade={{ getDiscoverySnapshot: async () => snapshot, scanTargets: async () => scanResult, searchOnlineSources: async () => searchPage([]), ...repoDiscoveryStubs }}
        onReviewCandidates={onReviewCandidates}
      />
    </I18nextProvider>,
  );

  await click(await screen.findByRole("button", { name: "重新扫描" }));
  const banner = await screen.findByRole("status");
  expect(banner).toHaveTextContent("发现 1 个待导入候选");
  fireEvent.click(screen.getByRole("button", { name: "审查并导入" }));
  expect(onReviewCandidates).toHaveBeenCalledTimes(1);
  // P1-04：审查入口必须携带本次扫描候选，不得让用户从零重选。
  expect(onReviewCandidates).toHaveBeenCalledWith([
    expect.objectContaining({ path: "C:/codex/skills/alpha" }),
  ]);
});

it("announces the scanning state while a scan is running", async () => {
  let resolveScan!: (value: ScanResult) => void;
  const scanTargets = vi.fn(
    () => new Promise<ScanResult>((resolve) => { resolveScan = resolve; }),
  );
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <LocalDiscoveryWorkbench
        facade={{ getDiscoverySnapshot: async () => snapshot, scanTargets, searchOnlineSources: async () => searchPage([]), ...repoDiscoveryStubs }}
      />
    </I18nextProvider>,
  );

  await click(await screen.findByRole("button", { name: "重新扫描" }));
  expect(screen.getByRole("status")).toHaveTextContent("正在扫描本机目录…");
  resolveScan(scanResult);
  // 扫描结束后状态播报消失，待导入横幅（同为 role=status）接管。
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("发现 1 个待导入候选"));
});

// —— P1-06：Agent 目录分组 / 类型徽标 / 不可用置底 / 安全排除 ——

const agentGroupSnapshot: DiscoverySnapshot = {
  generation: "7",
  observed_at: "1789114968",
  instances: [
    { profile_id: "zcode", client_id: "zcode-desktop", kind: "desktop", supported_os: ["windows", "macos"], client_presence: "Unknown" },
    { profile_id: "zcode", client_id: "zcode-cli", kind: "cli", supported_os: ["windows", "macos"], client_presence: "Unknown" },
    { profile_id: "brokenbrand", client_id: "broken-cli", kind: "cli", supported_os: ["windows"], client_presence: "Unknown" },
  ],
  logical_targets: [
    {
      id: "lt-agents",
      profile_id: "zcode",
      client_id: "zcode-desktop",
      scope: "global",
      path: "C:/u/.agents/skills",
      marker: "SKILL.md",
      precedence: "preferred",
      exists: true,
      readable: true,
      writable: true,
      available: true,
      physical_id: "phys-agents",
    },
    {
      id: "lt-agents-cli",
      profile_id: "zcode",
      client_id: "zcode-cli",
      scope: "global",
      path: "C:/u/.agents/skills",
      marker: "SKILL.md",
      precedence: "preferred",
      exists: true,
      readable: true,
      writable: true,
      available: true,
      physical_id: "phys-agents",
    },
    {
      id: "lt-broken",
      profile_id: "brokenbrand",
      client_id: "broken-cli",
      scope: "global",
      path: "C:/u/broken/skills",
      marker: "SKILL.md",
      precedence: "preferred",
      exists: true,
      readable: false,
      writable: false,
      available: false,
      physical_id: "phys-broken",
    },
  ],
  physical_targets: [
    {
      id: "phys-agents",
      path: "C:/u/.agents/skills",
      exists: true,
      readable: true,
      writable: true,
      case_behavior: "sensitive",
      logical_target_ids: ["lt-agents", "lt-agents-cli"],
    },
    {
      id: "phys-broken",
      path: "C:/u/broken/skills",
      exists: true,
      readable: false,
      writable: false,
      case_behavior: "sensitive",
      logical_target_ids: ["lt-broken"],
    },
  ],
};

it("groups discovered agent directories by brand with merged kind badges", async () => {
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <LocalDiscoveryWorkbench
        facade={{ getDiscoverySnapshot: async () => agentGroupSnapshot, scanTargets: async () => scanResult, searchOnlineSources: async () => searchPage([]), ...repoDiscoveryStubs }}
      />
    </I18nextProvider>,
  );

  expect(await screen.findByText("发现的 Agent 目录")).toBeVisible();
  // 同目录合并：同一品牌下 desktop 与 cli 聚合为一张卡片的类型集合。
  expect(screen.getByText("桌面端/CLI")).toBeVisible();
  expect(screen.getByText("C:/u/.agents/skills")).toBeVisible();
  // 完全不可用的品牌整体置底，单独分区说明。
  expect(screen.getByText("暂不可用")).toBeVisible();
  expect(screen.getByText("C:/u/broken/skills")).toBeVisible();
  // 可用目录不再重复标注不可用徽标。
  expect(screen.getAllByText("不可用")).toHaveLength(1);
});

// M-18：扫描/摘要/审查并导入固定在首屏工作区面板；Agent 目录盘点降级为
// 可折叠次级区，列表独占滚动所有者——操作不依赖滚动到底。
it("pins scan actions and summary in a panel above a collapsible agent inventory", async () => {
  const { container } = render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <LocalDiscoveryWorkbench
        facade={{ getDiscoverySnapshot: async () => agentGroupSnapshot, scanTargets: async () => scanResult, searchOnlineSources: async () => searchPage([]), ...repoDiscoveryStubs }}
        onReviewCandidates={vi.fn()}
      />
    </I18nextProvider>,
  );

  await click(await screen.findByRole("button", { name: "重新扫描" }));
  await waitFor(() => expect(screen.getByText("未纳管 1")).toBeVisible());

  // 滚动所有者只承载 Agent 目录盘点（长列表自滚动，不拉长页面）。
  const scrollOwner = container.querySelector<HTMLElement>(
    ".sh-discovery-workbench__inventory-scroll",
  );
  expect(scrollOwner).not.toBeNull();
  expect(
    scrollOwner!.querySelectorAll("li.sh-discovery-workbench__agent-card").length,
  ).toBeGreaterThan(0);

  // 首屏工作区：重新扫描、结果摘要、审查并导入都在滚动所有者之外。
  const rescan = screen.getByRole("button", { name: "重新扫描" });
  const review = screen.getByRole("button", { name: "审查并导入" });
  const scopeSummary = screen.getByText(/扫描范围：/);
  for (const element of [rescan, review, scopeSummary]) {
    expect(scrollOwner!.contains(element)).toBe(false);
  }

  // 几何断言：工作台面板承载动作与摘要，且位于滚动所有者之前（文档序）。
  const panel = container.querySelector(".sh-discovery-workbench__panel");
  expect(panel).not.toBeNull();
  expect(panel!.contains(rescan)).toBe(true);
  expect(panel!.contains(review)).toBe(true);
  expect(panel!.compareDocumentPosition(scrollOwner!) & Node.DOCUMENT_POSITION_FOLLOWING)
    .toBeTruthy();

  // 目录盘点是可折叠次级区：默认展开（既有语义不变），可折叠后再展开。
  const collapse = screen.getByRole("button", { name: "折叠" });
  expect(collapse).toHaveAttribute("aria-expanded", "true");
  await click(collapse);
  expect(scrollOwner).not.toBeVisible();
  const expand = screen.getByRole("button", { name: "展开" });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  await click(expand);
  expect(scrollOwner).toBeVisible();
});

it("keeps very long directory paths wrapped and reachable through a title hint (P2-02)", async () => {
  const longPath = `C:/very-long-root/${"segment-".repeat(24)}skills`;
  const longSnapshot: DiscoverySnapshot = {
    ...agentGroupSnapshot,
    logical_targets: agentGroupSnapshot.logical_targets.map((target) =>
      target.id === "lt-agents" ? { ...target, path: longPath } : target,
    ),
    physical_targets: agentGroupSnapshot.physical_targets.map((target) =>
      target.id === "phys-agents" ? { ...target, path: longPath } : target,
    ),
  };
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <LocalDiscoveryWorkbench
        facade={{ getDiscoverySnapshot: async () => longSnapshot, scanTargets: async () => scanResult, searchOnlineSources: async () => searchPage([]), ...repoDiscoveryStubs }}
      />
    </I18nextProvider>,
  );

  const pathCode = await screen.findByText(longPath);
  expect(pathCode).toHaveClass("sh-discovery-workbench__agent-path");
  // 完整值经原生 title 提示可达（与忽略项规则值同一策略）。
  expect(pathCode).toHaveAttribute("title", longPath);
  // CSS 层锁定换行策略：不靠横向滚动或裁切展示超长路径。
  expect(discoveryCss).toMatch(
    /\.sh-discovery-workbench__agent-path\s*\{[^}]*overflow-wrap:\s*anywhere/,
  );
});

it("excludes a directory only after confirmation via the ignore rule and never deletes files", async () => {
  const createIgnoreRule = vi.fn(async () => {});
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <LocalDiscoveryWorkbench
        facade={{ getDiscoverySnapshot: async () => agentGroupSnapshot, scanTargets: async () => scanResult, searchOnlineSources: async () => searchPage([]), ...repoDiscoveryStubs, createIgnoreRule }}
      />
    </I18nextProvider>,
  );

  await screen.findByText("发现的 Agent 目录");
  await click(screen.getAllByRole("button", { name: "排除" })[0]);

  // 先确认再执行；说明只影响发现，不碰用户文件。
  expect(createIgnoreRule).not.toHaveBeenCalled();
  await click(await screen.findByRole("button", { name: "确认排除" }));

  expect(createIgnoreRule).toHaveBeenCalledWith("C:/u/.agents/skills");
  // 成功后卡片从本次结果中移除并说明可撤销。
  await waitFor(() => expect(screen.queryByText("C:/u/.agents/skills")).not.toBeInTheDocument());
  expect(screen.getByText(/已排除 C:\/u\/.agents\/skills/)).toBeVisible();
  // 不可用分区仍在。
  expect(screen.getByText("C:/u/broken/skills")).toBeVisible();
});

it("keeps the directory visible with a readable error when the exclusion fails", async () => {
  const createIgnoreRule = vi.fn(async () => {
    throw { code: "operation.conflict", severity: "error", params: {}, actions: [] };
  });
  render(
    <I18nextProvider i18n={createSkillHubI18nSync()}>
      <LocalDiscoveryWorkbench
        facade={{ getDiscoverySnapshot: async () => agentGroupSnapshot, scanTargets: async () => scanResult, searchOnlineSources: async () => searchPage([]), ...repoDiscoveryStubs, createIgnoreRule }}
      />
    </I18nextProvider>,
  );

  await screen.findByText("发现的 Agent 目录");
  await click(screen.getAllByRole("button", { name: "排除" })[0]);
  await click(await screen.findByRole("button", { name: "确认排除" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("排除失败");
  // 失败不移除卡片，目录仍然可见。
  expect(screen.getByText("C:/u/.agents/skills")).toBeVisible();
});
