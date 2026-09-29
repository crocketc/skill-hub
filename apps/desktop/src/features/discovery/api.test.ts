import { describe, expect, it } from "vitest";
import type { AgentDirectoryProjection, SearchCandidateRecord } from "../../api/bindings";
import {
  buildAgentGroups,
  formatObservedAt,
  formatRelativeScanTime,
  isCandidateDismissedConflict,
  mergeCandidateEntries,
  parseRepoInput,
} from "./api";
import { buildAgentDirectoryCardModels } from "../agents/agentCardModel";

/**
 * P1-04：发现快照的 observed_at 有两种历史形态——ISO 字符串与
 * 后端 now() 产出的 epoch 秒十进制字符串（旧库快照仍如此）。
 * 展示必须是本地化日期时间，解析失败必须给占位而不是露出原始串。
 */
const projectDirectory = (role: "agent_native" | "shared_directory", identity: string, path: string, members: AgentDirectoryProjection["directories"][number]["members"]): AgentDirectoryProjection["directories"][number] => ({ role, identity: { kind: "verified_physical", value: identity }, path, status: "existing", exists: true, readable: true, writable: true, available: true, members });
const projectMember = (id: string, brand: string | null, kind: AgentDirectoryProjection["directories"][number]["members"][number]["kind"], client: string | null) => ({ logical_target_id: id, brand, client_id: client, kind, availability: { status: "existing" as const, exists: true, readable: true, writable: true, available: true }, capabilities: { deployment: { copy: true, symlink: true, junction: true }, modes: ["managed_copy" as const, "symbolic_link" as const, "directory_junction" as const], preferred_mode: "symbolic_link" as const }, deployment_status: "not_deployed" as const, managed_deployment_relation_count: 0, managed_deployment_count: 0 });
const directoryProjection: AgentDirectoryProjection = { directories: [
  projectDirectory("agent_native", "physical-cursor", "C:\\Users\\me\\.cursor\\skills", [projectMember("editor", "cursor", "desktop", "cursor-editor"), projectMember("cli", "cursor", "cli", "cursor-cli")]),
  projectDirectory("shared_directory", "physical-shared", "C:/Users/ME/.agents/skills", [projectMember("recognized", "openai", "cli", "codex-cli"), projectMember("unknown", null, null, null)]),
] };

describe("discovery directory projection parity", () => {
  it("retains canonical identities, type sets, recognized shared brands, and availability", () => {
    const models = buildAgentDirectoryCardModels(directoryProjection);
    const groups = buildAgentGroups(directoryProjection);
    const cards = [...groups.available, ...groups.unavailable].flatMap((group) => group.cards);
    expect(cards.map((card) => card.physicalId).toSorted()).toEqual(models.map((model) => model.id).toSorted());
    expect(cards.find((card) => card.path.includes(".cursor"))?.kinds).toEqual(["desktop", "cli"]);
    expect(cards.find((card) => card.kinds.includes("shared_directory"))?.sharedBrands).toEqual(["openai"]);
    expect(cards.every((card) => card.available)).toBe(true);
  });

  it("keeps candidate identities distinct across Windows separator and case variants", () => {
    const source = directoryProjection.directories[0]!;
    const pending = { ...source, identity: { kind: "candidate" as const, value: "candidate-two" }, path: "c:/users/me/.cursor/skills", status: "missing" as const, exists: false, readable: false, writable: false, available: false, members: [{ ...source.members[0]!, logical_target_id: "pending", availability: { status: "missing" as const, exists: false, readable: false, writable: false, available: false } }] };
    const projection: AgentDirectoryProjection = { directories: [...directoryProjection.directories, pending] };
    const groups = buildAgentGroups(projection);
    const cards = [...groups.available, ...groups.unavailable].flatMap((group) => group.cards);
    expect(cards.filter((card) => card.path.toLowerCase().includes(".cursor"))).toHaveLength(2);
    expect(cards.map((card) => card.physicalId).toSorted()).toEqual(buildAgentDirectoryCardModels(projection).map((model) => model.id).toSorted());
  });
});
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
