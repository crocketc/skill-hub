import { describe, expect, it } from "vitest";
import type { DiscoverySnapshot, SearchCandidateRecord } from "../../api/bindings";
import {
  buildAgentGroups,
  formatObservedAt,
  formatRelativeScanTime,
  isCandidateDismissedConflict,
  mergeCandidateEntries,
  parseRepoInput,
} from "./api";

/**
 * P1-04：发现快照的 observed_at 有两种历史形态——ISO 字符串与
 * 后端 now() 产出的 epoch 秒十进制字符串（旧库快照仍如此）。
 * 展示必须是本地化日期时间，解析失败必须给占位而不是露出原始串。
 */
describe("formatObservedAt", () => {
  it("formats an ISO timestamp as a localized date time", () => {
    expect(
      formatObservedAt("2026-09-05T08:00:00Z", { locale: "en-US", timeZone: "UTC" }),
    ).toBe("Sep 5, 2026, 8:00 AM");
    expect(
      formatObservedAt("2026-09-05T08:00:00Z", { locale: "zh-CN", timeZone: "UTC" }),
    ).toBe("2026年9月5日 08:00");
  });

  it("parses the backend epoch-seconds decimal string instead of leaking it", () => {
    expect(
      formatObservedAt("1789114968", { locale: "en-US", timeZone: "UTC" }),
    ).toBe("Sep 11, 2026, 8:22 AM");
  });

  it("parses an epoch-seconds number (ScanGeneration.observed_at shape)", () => {
    expect(
      formatObservedAt(1789114968, { locale: "en-US", timeZone: "UTC" }),
    ).toBe("Sep 11, 2026, 8:22 AM");
    // 毫秒级时间戳同样兼容（>= 1e12 视为毫秒）。
    expect(
      formatObservedAt(1789114968000, { locale: "en-US", timeZone: "UTC" }),
    ).toBe("Sep 11, 2026, 8:22 AM");
  });

  it("returns null for unparseable input so callers can show an honest placeholder", () => {
    expect(formatObservedAt("not-a-date")).toBeNull();
    expect(formatObservedAt("")).toBeNull();
    expect(formatObservedAt("99999999999999999999")).toBeNull();
  });
});

/**
 * P1-06：发现页 Agent 分组纯函数。按品牌分组、组内按 physical_id 合并
 * 同目录、聚合去重后的客户端类型；可用在前、完全不可用的品牌置底；
 * 按当前 OS 过滤 profile 声明的 supported_os。
 */
const agentSnapshot: DiscoverySnapshot = {
  generation: "1",
  observed_at: "1789114968",
  instances: [
    // OPT-20260914-07：通用 Agent 目录伪客户端（品牌无关的归属入口）。
    { profile_id: "agent-skills", client_id: "agent-skills.shared-directory", display_name: "Agent Skills", kind: "shared_directory", supported_os: ["windows", "macos"], client_presence: "Unknown" },
    { profile_id: "zcode", client_id: "zcode-desktop", display_name: "ZCode", kind: "desktop", supported_os: ["windows", "macos"], client_presence: "Unknown" },
    { profile_id: "zcode", client_id: "zcode-cli", display_name: "ZCode CLI", kind: "cli", supported_os: ["windows", "macos"], client_presence: "Unknown" },
    { profile_id: "codex", client_id: "codex-cli", display_name: "Codex CLI", kind: "cli", supported_os: ["windows", "macos"], client_presence: "Unknown" },
    // 仅 macOS：在 Windows 上必须被过滤。
    { profile_id: "claudedesktop", client_id: "claude-desktop", display_name: "Claude Desktop", kind: "desktop", supported_os: ["macos"], client_presence: "Unknown" },
    // 完全不可用的品牌（目标目录缺失）。
    { profile_id: "brokenbrand", client_id: "broken-cli", display_name: "Broken CLI", kind: "cli", supported_os: ["windows"], client_presence: "Unknown" },
  ],
  logical_targets: [
    // 通用归属条目：.agents/skills 的归属卡片只由 agent-skills 产出。
    sharedTarget("lt-generic-agents", "agent-skills", "agent-skills.shared-directory", "C:/u/.agents/skills", "phys-agents", true, false),
    // zcode desktop 与 codex cli 以共享引用方式看到同一目录：不再各自产出归属卡片。
    sharedTarget("lt-zcode-agents", "zcode", "zcode-desktop", "C:/u/.agents/skills", "phys-agents", true, true),
    sharedTarget("lt-codex-agents", "codex", "codex-cli", "C:/u/.agents/skills", "phys-agents", true, true),
    // zcode desktop 的原生候选（.zcode/skills）：不可用，仍归属 zcode 自己。
    target("lt-zcode-lower", "zcode", "zcode-desktop", "C:/u/.zcode/skills", "phys-zcode", false),
    // zcode cli 也以共享引用指向 ~/.agents/skills。
    sharedTarget("lt-zcode-cli", "zcode", "zcode-cli", "C:/u/.agents/skills", "phys-agents", true, true),
    // 完全不可用的品牌：置底分区。
    target("lt-broken", "brokenbrand", "broken-cli", "C:/u/broken/skills", "phys-broken", false),
  ],
  physical_targets: [
    physical("phys-agents", "C:/u/.agents/skills"),
    physical("phys-zcode", "C:/u/.zcode/skills"),
    physical("phys-broken", "C:/u/broken/skills"),
  ],
};

function target(
  id: string,
  profileId: string,
  clientId: string,
  path: string,
  physicalId: string,
  available: boolean,
): DiscoverySnapshot["logical_targets"][number] {
  return sharedTarget(id, profileId, clientId, path, physicalId, available, false);
}

function sharedTarget(
  id: string,
  profileId: string,
  clientId: string,
  path: string,
  physicalId: string,
  available: boolean,
  sharedReference: boolean,
): DiscoverySnapshot["logical_targets"][number] {
  return {
    id,
    profile_id: profileId,
    client_id: clientId,
    scope: "global",
    path,
    marker: "SKILL.md",
    precedence: "preferred",
    shared_reference: sharedReference,
    exists: true,
    readable: available,
    writable: available,
    available,
    physical_id: physicalId,
  };
}

function physical(
  id: string,
  path: string,
): DiscoverySnapshot["physical_targets"][number] {
  return {
    id,
    path,
    exists: true,
    readable: true,
    writable: true,
    case_behavior: "sensitive",
    logical_target_ids: [],
  };
}

describe("buildAgentGroups", () => {
  const { available, unavailable } = buildAgentGroups(agentSnapshot, { os: "windows" });

  it("filters instances by the current OS before grouping", () => {
    const brands = [...available, ...unavailable].map((group) => group.brand);
    expect(brands).not.toContain("claudedesktop");
  });

  it("groups by brand and merges same-directory targets into one card with joined kinds", () => {
    // OPT-20260914-07：~/.agents/skills 归属收归 agent-skills 后，zcode 只剩
    // 原生目录卡片；共享引用保留可用性，但不再产出归属卡片。zcode 的原生
    // 目录不可用，因此整个分组沉到不可用分区。
    const zcode = [...available, ...unavailable].find((group) => group.brand === "zcode");
    expect(zcode).toBeDefined();
    expect(zcode!.available).toBe(false);
    expect(zcode!.cards).toHaveLength(1);
    expect(zcode!.cards[0]).toMatchObject({
      path: "C:/u/.zcode/skills",
      available: false,
    });
  });

  it("produces exactly one brand-agnostic ownership card for the shared agents directory", () => {
    // OPT-20260914-07：通用目录归属卡片全页只出现一次。
    const generic = available.find((group) => group.brand === "agent-skills");
    expect(generic).toBeDefined();
    expect(generic!.cards).toHaveLength(1);
    expect(generic!.cards[0]).toMatchObject({
      physicalId: "phys-agents",
      path: "C:/u/.agents/skills",
      kinds: ["shared_directory"],
      available: true,
      sharedClients: 3,
    });
    // 共享引用的品牌不再重复产出该目录的卡片。
    expect(available.find((group) => group.brand === "codex")).toBeUndefined();
    const brandAgentCards = [...available, ...unavailable]
      .filter((group) => group.brand !== "agent-skills")
      .flatMap((group) => group.cards)
      .filter((card) => card.path === "C:/u/.agents/skills");
    expect(brandAgentCards).toEqual([]);
  });

  it("carries official client names on cards and shared reference names on the generic card", () => {
    const generic = available.find((group) => group.brand === "agent-skills")!;
    expect(generic.cards[0].sharedClientNames).toEqual(
      expect.arrayContaining(["ZCode", "ZCode CLI", "Codex CLI"]),
    );
    // 旧快照没有 display_name 时回退 client_id，不产生 undefined。
    const legacy = buildAgentGroups(
      {
        ...agentSnapshot,
        instances: [{ profile_id: "p", client_id: "legacy", kind: "cli", supported_os: [], client_presence: "Unknown" }],
        logical_targets: [{
          id: "lt-legacy",
          profile_id: "p",
          client_id: "legacy",
          scope: "global",
          path: "C:/u/legacy/skills",
          marker: "SKILL.md",
          precedence: "preferred",
          exists: true,
          readable: true,
          writable: true,
          available: true,
          physical_id: "phys-legacy",
        }],
        physical_targets: [],
      },
      { os: "windows" },
    );
    expect(legacy.available[0].cards[0].names).toEqual(["legacy"]);
  });

  it("merges different product forms sharing one native path into a single card", () => {
    // B.2：同品牌不同产品形态（桌面端 + 终端 CLI）共用同一路径时，
    // 合并为一张卡片，形态标签并列、官方产品名并列。
    const cursorSnapshot: DiscoverySnapshot = {
      generation: "2",
      observed_at: "1789114968",
      instances: [
        { profile_id: "cursor", client_id: "cursor-editor", display_name: "Cursor", kind: "desktop", supported_os: ["windows", "macos"], client_presence: "Unknown" },
        { profile_id: "cursor", client_id: "cursor-cli", display_name: "Cursor CLI", kind: "cli", supported_os: ["windows", "macos"], client_presence: "Unknown" },
      ],
      logical_targets: [
        target("lt-editor", "cursor", "cursor-editor", "C:/u/.cursor/skills", "phys-cursor", true),
        target("lt-cli", "cursor", "cursor-cli", "C:/u/.cursor/skills", "phys-cursor", true),
      ],
      physical_targets: [physical("phys-cursor", "C:/u/.cursor/skills")],
    };
    const { available: merged } = buildAgentGroups(cursorSnapshot, { os: "windows" });
    expect(merged).toHaveLength(1);
    const card = merged[0].cards[0];
    expect(card.kinds).toEqual(["desktop", "cli"]);
    expect(card.names).toEqual(["Cursor", "Cursor CLI"]);
    expect(card.path).toBe("C:/u/.cursor/skills");
  });

  it("keeps legacy snapshots without shared_reference working as ownership cards", () => {
    // 向后兼容：旧库快照没有 shared_reference 字段，行为与迁移前一致。
    const legacyTargets = agentSnapshot.logical_targets.map(
      ({ shared_reference: _shared, ...rest }) => rest,
    );
    const legacy = buildAgentGroups(
      { ...agentSnapshot, logical_targets: legacyTargets },
      { os: "windows" },
    );
    const zcode = legacy.available.find((group) => group.brand === "zcode");
    expect(zcode!.cards.map((card) => card.physicalId)).toContain("phys-agents");
  });

  it("sorts available brands first and sinks wholly unavailable brands to the bottom", () => {
    expect(available.map((group) => group.brand)).toEqual(["agent-skills"]);
    expect(unavailable.map((group) => group.brand)).toEqual(["brokenbrand", "zcode"]);
    // 组内卡片：可用在前，不可用置底。
    expect(unavailable.find((group) => group.brand === "zcode")!.cards.map((card) => card.available))
      .toEqual([false]);
  });

  it("returns empty sections when nothing is discovered", () => {
    const empty = buildAgentGroups(
      { ...agentSnapshot, instances: [], logical_targets: [], physical_targets: [] },
      { os: "windows" },
    );
    expect(empty.available).toEqual([]);
    expect(empty.unavailable).toEqual([]);
  });
});

/**
 * P1-05：候选确认闭环的纯函数。candidate id 由后端派生（sha256），
 * 前端只能按 provider_source_id（即 hit.source_id）归并；
 * dismissed→confirmed 被原生层拒绝（OperationConflict reason=candidate_dismissed），
 * UI 必须在调用 describeNativeError 之前识别该冲突并给出专属文案。
 */
describe("search candidate helpers", () => {
  const conflictError = {
    code: "operation.conflict",
    severity: "warning",
    params: { reason: "candidate_dismissed", candidate_id: "candidate:abc" },
    actions: ["acknowledge"],
  };

  it("detects the candidate_dismissed conflict across error shapes", () => {
    expect(isCandidateDismissedConflict(conflictError)).toBe(true);
    expect(isCandidateDismissedConflict(new Error(JSON.stringify(conflictError)))).toBe(true);
    expect(isCandidateDismissedConflict(JSON.stringify(conflictError))).toBe(true);
  });

  it("keeps other conflicts and opaque failures out of the dismissed branch", () => {
    expect(
      isCandidateDismissedConflict({
        code: "operation.conflict",
        severity: "warning",
        params: { reason: "no_upstream_source" },
        actions: [],
      }),
    ).toBe(false);
    expect(
      isCandidateDismissedConflict({
        code: "object.not_found",
        severity: "warning",
        params: { kind: "search candidate" },
        actions: [],
      }),
    ).toBe(false);
    expect(isCandidateDismissedConflict("ipc down")).toBe(false);
    expect(isCandidateDismissedConflict(null)).toBe(false);
  });

  it("merges candidate records by provider_source_id without mutating the previous map", () => {
    const record = (sourceId: string, id: string, status: SearchCandidateRecord["status"]): SearchCandidateRecord => ({
      id,
      provider: "skills_sh",
      provider_source_id: sourceId,
      name: sourceId,
      source: { kind: "https", locator: { https_url: "https://example.test/repo" } },
      page_url: "https://example.test",
      installs: 1,
      via: "original_query",
      first_seen_at: "1789114968",
      status,
    });
    const prev = new Map([["a", { id: "c1", status: "confirmed" as const }]]);

    const merged = mergeCandidateEntries(prev, [
      record("a", "c1", "dismissed"),
      record("b", "c2", "pending"),
    ]);

    expect(merged.get("a")).toEqual({ id: "c1", status: "dismissed" });
    expect(merged.get("b")).toEqual({ id: "c2", status: "pending" });
    // 旧映射不被改写：合并总是产生新 Map。
    expect(prev.get("a")).toEqual({ id: "c1", status: "confirmed" });
  });
});

/**
 * D4：仓库管理页的地址解析纯函数。接受四种形态——owner/name、
 * 完整 GitHub URL、.git 后缀、/tree/branch 子路径——其余一律拒绝，
 * 由调用方给出行内提示而不是把坏坐标提交给后端。
 */
describe("parseRepoInput", () => {
  it.each([
    ["anthropics/skills", { owner: "anthropics", name: "skills", branch: "" }],
    [
      "https://github.com/anthropics/skills",
      { owner: "anthropics", name: "skills", branch: "" },
    ],
    [
      "https://github.com/anthropics/skills.git",
      { owner: "anthropics", name: "skills", branch: "" },
    ],
    [
      "https://github.com/anthropics/skills/tree/feature/new-thing",
      { owner: "anthropics", name: "skills", branch: "feature/new-thing" },
    ],
    // 附带形态：裸 .git 后缀、www 主机、http、末尾斜杠。
    ["octocat/hello-world.git", { owner: "octocat", name: "hello-world", branch: "" }],
    [
      "https://www.github.com/Octocat/Hello-World/",
      { owner: "Octocat", name: "Hello-World", branch: "" },
    ],
  ])("parses %s", (input, expected) => {
    expect(parseRepoInput(input)).toEqual(expected);
  });

  it.each([
    "",
    "just-a-name",
    "https://gitlab.com/anthropics/skills",
    "https://github.com/anthropics",
    "https://github.com/anthropics/skills/extra",
    "bad..owner/skills",
    "anthropics/../skills",
    "anthropics/skills/tree",
    "anthropics/skills/tree/.hidden",
  ])("rejects %s", (input) => {
    expect(parseRepoInput(input)).toBeNull();
  });
});

/**
 * D4：上次扫描时间的相对展示。近程用 Intl.RelativeTimeFormat，
 * 更早回退本地化日期；不可解析的时间戳返回 null 绝不露原始串。
 */
describe("formatRelativeScanTime", () => {
  const now = new Date("2026-09-14T12:00:00Z");

  it("formats recent timestamps as relative text in the requested locale", () => {
    expect(
      formatRelativeScanTime("2026-09-14T11:58:00Z", { locale: "zh-CN", now }),
    ).toBe("2分钟前");
    expect(
      formatRelativeScanTime("2026-09-14T12:00:00Z", { locale: "en-US", now }),
    ).toBe("now");
  });

  it("falls back to a localized date for older scans", () => {
    expect(
      formatRelativeScanTime("2026-01-05T00:00:00Z", { locale: "en-US", now, timeZone: "UTC" }),
    ).toMatch(/^Jan 5, 2026/);
  });

  it("returns null for unparseable timestamps", () => {
    expect(formatRelativeScanTime("not-a-date", { now })).toBeNull();
  });
});
