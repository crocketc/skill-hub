import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import type {
  DiscoverySnapshot,
  ScanResult,
  SourceSearchHit,
  SourceSearchPage,
} from "../../api/bindings";
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
