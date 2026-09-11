import { describe, expect, it } from "vitest";
import type { DiscoverySnapshot, SearchCandidateRecord } from "../../api/bindings";
import {
  buildAgentGroups,
  formatObservedAt,
  isCandidateDismissedConflict,
  mergeCandidateEntries,
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
    { profile_id: "zcode", client_id: "zcode-desktop", kind: "desktop", supported_os: ["windows", "macos"], client_presence: "Unknown" },
    { profile_id: "zcode", client_id: "zcode-cli", kind: "cli", supported_os: ["windows", "macos"], client_presence: "Unknown" },
    { profile_id: "codex", client_id: "codex-cli", kind: "cli", supported_os: ["windows", "macos"], client_presence: "Unknown" },
    // 仅 macOS：在 Windows 上必须被过滤。
    { profile_id: "claudedesktop", client_id: "claude-desktop", kind: "desktop", supported_os: ["macos"], client_presence: "Unknown" },
    // 完全不可用的品牌（目标目录缺失）。
    { profile_id: "brokenbrand", client_id: "broken-cli", kind: "cli", supported_os: ["windows"], client_presence: "Unknown" },
  ],
  logical_targets: [
    // zcode desktop 与 codex cli 共享 ~/.agents/skills（同一 physical）。
    target("lt-zcode-agents", "zcode", "zcode-desktop", "C:/u/.agents/skills", "phys-agents", true),
    target("lt-codex-agents", "codex", "codex-cli", "C:/u/.agents/skills", "phys-agents", true),
    // zcode desktop 的 lower_priority_copy 候选（.zcode/skills）：不可用。
    target("lt-zcode-lower", "zcode", "zcode-desktop", "C:/u/.zcode/skills", "phys-zcode", false),
    // zcode cli 也指向 ~/.agents/skills：合并后 zcode 卡片类型为 desktop+cli。
    target("lt-zcode-cli", "zcode", "zcode-cli", "C:/u/.agents/skills", "phys-agents", true),
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
  return {
    id,
    profile_id: profileId,
    client_id: clientId,
    scope: "global",
    path,
    marker: "SKILL.md",
    precedence: "preferred",
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
    const zcode = available.find((group) => group.brand === "zcode");
    expect(zcode).toBeDefined();
    expect(zcode!.cards).toHaveLength(2);
    const agentsCard = zcode!.cards.find((card) => card.physicalId === "phys-agents");
    expect(agentsCard).toMatchObject({
      path: "C:/u/.agents/skills",
      available: true,
    });
    // 同目录合并：desktop 与 cli 聚合为一张卡片的类型集合。
    expect(agentsCard!.kinds).toEqual(["desktop", "cli"]);
    // 不可用的 lower_priority_copy 候选保留为独立卡片（不同目录）。
    const lowerCard = zcode!.cards.find((card) => card.physicalId === "phys-zcode");
    expect(lowerCard).toMatchObject({ available: false, path: "C:/u/.zcode/skills" });
  });

  it("keeps cross-brand sharing of one directory as separate brand cards", () => {
    const codex = available.find((group) => group.brand === "codex");
    expect(codex!.cards).toHaveLength(1);
    expect(codex!.cards[0]).toMatchObject({
      physicalId: "phys-agents",
      path: "C:/u/.agents/skills",
      kinds: ["cli"],
      available: true,
    });
  });

  it("sorts available brands first and sinks wholly unavailable brands to the bottom", () => {
    expect(available.map((group) => group.brand)).toEqual(["codex", "zcode"]);
    expect(unavailable.map((group) => group.brand)).toEqual(["brokenbrand"]);
    // 组内卡片：可用在前，不可用置底。
    expect(available.find((group) => group.brand === "zcode")!.cards.map((card) => card.available))
      .toEqual([true, false]);
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
