import { describe, expect, it } from "vitest";
import type { AgentDirectoryProjection, DiscoverySnapshot, SearchCandidateRecord } from "../../api/bindings";
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
const projectDirectory = (role: "agent_native" | "shared_directory" | "project" | "builtin", identity: string, path: string, members: AgentDirectoryProjection["directories"][number]["members"]): AgentDirectoryProjection["directories"][number] => ({ role, identity: { kind: "verified_physical", value: identity }, path, status: "existing", exists: true, readable: true, writable: true, available: true, members });
const projectMember = (id: string, brand: string | null, kind: AgentDirectoryProjection["directories"][number]["members"][number]["kind"], client: string | null) => ({ logical_target_id: id, brand, client_id: client, kind, availability: { status: "existing" as const, exists: true, readable: true, writable: true, available: true }, capabilities: { deployment: { copy: true, symlink: true, junction: true }, modes: ["managed_copy" as const, "symbolic_link" as const, "directory_junction" as const], preferred_mode: "symbolic_link" as const }, deployment_status: "not_deployed" as const, managed_deployment_relation_count: 0, managed_deployment_count: 0 });
const directoryProjection: AgentDirectoryProjection = { directories: [
  projectDirectory("agent_native", "physical-cursor", "C:\\Users\\me\\.cursor\\skills", [projectMember("editor", "cursor", "desktop", "cursor-editor"), projectMember("cli", "cursor", "cli", "cursor-cli")]),
  projectDirectory("shared_directory", "physical-shared", "C:/Users/ME/.agents/skills", [projectMember("recognized", "openai", "cli", "codex-cli"), projectMember("unknown", null, null, null)]),
] };

describe("discovery directory projection parity", () => {
  it("does not render project directories in Agent discovery groups", () => {
    const project = projectDirectory("project", "project-skills", "C:/repo/.agents/skills", [
      projectMember("project-member", "openai", "cli", "codex-cli"),
    ]);
    const groups = buildAgentGroups({ directories: [project] });
    expect(groups.available).toEqual([]);
    expect(groups.unavailable).toEqual([]);
  });

  it("retains canonical identities, type sets, recognized shared brands, and availability", () => {
    const models = buildAgentDirectoryCardModels(directoryProjection);
    const groups = buildAgentGroups(directoryProjection);
    const cards = [...groups.available, ...groups.unavailable].flatMap((group) => group.cards);
    expect(cards.map((card) => card.physicalId).sort()).toEqual(models.map((model) => model.id).sort());
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
    expect(cards.map((card) => card.physicalId).sort()).toEqual(buildAgentDirectoryCardModels(projection).map((model) => model.id).sort());
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

  it("creates the shared directory card when the snapshot only contains brand references", () => {
    const referenceOnly = buildAgentGroups(
      {
        ...agentSnapshot,
        instances: agentSnapshot.instances.filter((instance) =>
          ["zcode-desktop", "codex-cli"].includes(instance.client_id),
        ),
        logical_targets: agentSnapshot.logical_targets
          .filter((target) => target.physical_id === "phys-agents")
          .map((target) => ({ ...target, shared_reference: true })),
      },
      { os: "windows" },
    );

    expect(referenceOnly.available).toHaveLength(1);
    expect(referenceOnly.available[0]).toMatchObject({
      brand: "agent-skills",
      cards: [
        {
          physicalId: "phys-agents",
          path: "C:/u/.agents/skills",
          sharedClients: 2,
        },
      ],
    });
  });

  it("carries official client names on cards and shared reference names on the generic card", () => {
    const generic = available.find((group) => group.brand === "agent-skills")!;
    expect(generic.cards[0].sharedClientNames).toHaveLength(3);
    expect(generic.cards[0].sharedClientNames).toEqual(
      expect.arrayContaining(["ZCode", "ZCode CLI", "Codex CLI"]),
    );
    // 旧快照没有 display_name 时回退品牌展示名，不泄露 client_id。
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
    expect(legacy.available[0].cards[0].names).toEqual(["P"]);
    expect(legacy.available[0].cards[0].names).not.toContain("legacy");
  });

  it("uses readable brand names when shared client display names are absent", () => {
    const unnamed = buildAgentGroups({
      ...agentSnapshot,
      instances: agentSnapshot.instances.map(({ display_name: _displayName, ...instance }) => instance),
    }, { os: "windows" });
    const shared = unnamed.available.find((group) => group.brand === "agent-skills")?.cards[0];
    expect(shared?.sharedClientNames).toEqual(["ZCode", "Codex"]);
    expect(shared?.sharedClientNames).not.toContain("zcode-desktop");
    expect(shared?.sharedClientNames).not.toContain("codex-cli");
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

  it("recognizes legacy shared ownership from the generic directory instance", () => {
    // 旧库快照没有 shared_reference 字段时，仍由通用共享目录事实识别身份。
    const legacyTargets = agentSnapshot.logical_targets.map(
      ({ shared_reference: _shared, ...rest }) => rest,
    );
    const legacy = buildAgentGroups(
      { ...agentSnapshot, logical_targets: legacyTargets },
      { os: "windows" },
    );
    const sharedCards = [...legacy.available, ...legacy.unavailable]
      .flatMap((group) => group.cards)
      .filter((card) => card.path === "C:/u/.agents/skills");
    expect(sharedCards).toHaveLength(1);
    expect(sharedCards[0]).toMatchObject({ physicalId: "phys-agents", sharedClients: 3 });
    expect(legacy.available.find((group) => group.brand === "codex")).toBeUndefined();
  });

  it("sorts available brands first and sinks wholly unavailable brands to the bottom", () => {
    expect(available.map((group) => group.brand)).toEqual(["agent-skills"]);
    expect(unavailable.map((group) => group.brand)).toEqual(["brokenbrand", "zcode"]);
    // 组内卡片：可用在前，不可用置底。
    expect(unavailable.find((group) => group.brand === "zcode")!.cards.map((card) => card.available))
      .toEqual([false]);
  });

  it("does not revive separator-spelled legacy variants of a shared directory as brand cards", () => {
    // 验收反馈（2026-09-25）：merge_history 保留的旧扫描条目把
    // `.agents/skills` 的末段分隔符写成 `/`，shared_reference 反序列化为
    // false。前端必须按文件系统身份识别它就是共享目录本身，不能再产出
    // 「品牌 + 不可用」的幽灵卡。
    const cleanShared = sharedTarget("lt-codex-agents", "codex", "codex-cli", "C:\\u\\.agents\\skills", "phys-agents", true, true);
    const ghostVariant = {
      ...sharedTarget("lt-codex-agents-legacy", "codex", "codex-cli", "C:\\u\\.agents\\skills", "phys-agents-legacy", false, false),
      // 仅末段分隔符不同的历史拼写；可用性已被历史合并清零。
      path: "C:\\u\\.agents/skills",
      exists: false,
      readable: false,
      writable: false,
    };
    const ghostSnapshot: DiscoverySnapshot = {
      ...agentSnapshot,
      logical_targets: [cleanShared, ghostVariant],
      instances: agentSnapshot.instances.filter((instance) => instance.profile_id === "agent-skills" || instance.profile_id === "codex"),
    };
    const { available, unavailable } = buildAgentGroups(ghostSnapshot, { os: "windows" });
    const codexCards = [...available, ...unavailable]
      .find((group) => group.brand === "codex")?.cards ?? [];
    expect(codexCards).toEqual([]);
    // 共享目录本身仍以通用归属卡呈现，共享计数不因幽灵条目重复累计。
    const generic = available.find((group) => group.brand === "agent-skills");
    expect(generic?.cards).toHaveLength(1);
    expect(generic?.cards[0]?.sharedClients).toBe(1);
  });

  it("returns empty sections when nothing is discovered", () => {
    const empty = buildAgentGroups(
      { ...agentSnapshot, instances: [], logical_targets: [], physical_targets: [] },
      { os: "windows" },
    );
    expect(empty.available).toEqual([]);
    expect(empty.unavailable).toEqual([]);
  });

  it("keeps existing built-in directories as separate read-only builtin cards", () => {
    // 2026-09-25 验收裁决：内置技能目录独立成「内置」类型卡片；同目录多
    // 客户端合并为一张；不存在的内置目录（平台自管，本机未随装）不渲染。
    const builtinTarget = (
      id: string,
      profileId: string,
      clientId: string,
      path: string,
      physicalId: string,
      available: boolean,
      exists = true,
    ) => ({
      ...target("x", profileId, clientId, path, physicalId, available),
      id,
      builtin: true,
      exists,
      readable: exists && available,
      writable: exists && available,
    });
    const builtinSnapshot: DiscoverySnapshot = {
      generation: "1",
      observed_at: "1789114968",
      instances: [
        { profile_id: "openai", client_id: "openai.codex-cli", display_name: "Codex CLI", kind: "cli", supported_os: ["windows", "macos"], client_presence: "Unknown" },
        { profile_id: "openai", client_id: "openai.codex-desktop", display_name: "Codex Desktop", kind: "desktop", supported_os: ["windows", "macos"], client_presence: "Unknown" },
        { profile_id: "cursor", client_id: "cursor.editor", display_name: "Cursor", kind: "desktop", supported_os: ["windows", "macos"], client_presence: "Unknown" },
      ],
      logical_targets: [
        target("lt-codex-user", "openai", "openai.codex-cli", "C:/u/.codex/skills", "phys-codex-user", true),
        builtinTarget("lt-codex-sys-cli", "openai", "openai.codex-cli", "C:/u/.codex/skills/.system", "phys-codex-system", true),
        builtinTarget("lt-codex-sys-desktop", "openai", "openai.codex-desktop", "C:/u/.codex/skills/.system", "phys-codex-system", true),
        builtinTarget("lt-cursor-builtin", "cursor", "cursor.editor", "C:/u/.cursor/skills-cursor", "phys-cursor-builtin", false, false),
      ],
      physical_targets: [
        physical("phys-codex-user", "C:/u/.codex/skills"),
        physical("phys-codex-system", "C:/u/.codex/skills/.system"),
      ],
    };
    const { available } = buildAgentGroups(builtinSnapshot, { os: "windows" });
    const openai = available.find((group) => group.brand === "openai");
    expect(openai).toBeDefined();
    expect(openai!.cards).toHaveLength(2);
    const userCard = openai!.cards.find((card) => !card.builtin);
    expect(userCard).toMatchObject({ path: "C:/u/.codex/skills", available: true });
    const builtinCard = openai!.cards.find((card) => card.builtin);
    expect(builtinCard).toMatchObject({
      path: "C:/u/.codex/skills/.system",
      physicalId: "phys-codex-system",
      available: true,
    });
    // 本机不存在的内置目录不出卡：cursor 品牌整体不渲染。
    expect(available.find((group) => group.brand === "cursor")).toBeUndefined();
    expect(unavailable.find((group) => group.brand === "cursor")).toBeUndefined();
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

describe("discovery compatibility behavior", () => {
  it("omits missing builtin cards and preserves availability ordering within brand sections", () => {
    const member = projectMember("member", "codex", "cli", "codex-cli");
    const available = projectDirectory("agent_native", "available", "C:/u/codex/skills", [member]);
    const unavailable = { ...projectDirectory("agent_native", "unavailable", "C:/u/codex/old", [member]), available: false, readable: false, writable: false, members: [{ ...member, logical_target_id: "old", availability: { status: "inaccessible" as const, exists: true, readable: false, writable: false, available: false } }] };
    const missingBuiltin = { ...projectDirectory("builtin", "builtin-missing", "C:/u/codex/.system", [member]) };
    missingBuiltin.exists = false;
    missingBuiltin.available = false;
    missingBuiltin.readable = false;
    missingBuiltin.writable = false;
    missingBuiltin.status = "missing";
    const groups = buildAgentGroups({ directories: [unavailable, missingBuiltin, available] });
    expect(groups.available).toHaveLength(1);
    expect(groups.available[0]?.cards.map((card) => card.available)).toEqual([true, false]);
    expect(groups.available.flatMap((group) => group.cards).some((card) => card.builtin)).toBe(false);
  });

  it("excludes the generic shared owner from shared brand names and client counts", () => {
    const shared = projectDirectory("shared_directory", "shared-production", "C:/u/.agents/skills", [
      projectMember("owner", "agent-skills", "shared_directory", "agent-skills.shared-directory"),
      projectMember("owner-alias", "openai", "shared_directory", "agent-skills.shared-directory"),
      projectMember("recognized", "openai", "cli", "codex-cli"),
      projectMember("unknown-root", null, null, null),
    ]);
    const card = buildAgentGroups({ directories: [shared] }).available[0]?.cards[0];
    expect(card?.sharedBrands).toEqual(["openai"]);
    expect(card?.sharedBrandKinds).toEqual({ openai: ["cli"] });
    expect(card?.sharedClients).toBe(1);
    expect(card?.sharedClientNames).toEqual(["OpenAI"]);
    expect(card?.names).toEqual(["OpenAI"]);
  });

  it("keeps the snapshot-and-OS compatibility signature and filters unsupported clients", () => {
    const snapshot: DiscoverySnapshot = {
      generation: "1", observed_at: "1789114968",
      instances: [
        { profile_id: "cursor", client_id: "cursor-cli", display_name: "Cursor CLI", kind: "cli", supported_os: ["windows"], client_presence: "Unknown" },
        { profile_id: "cursor", client_id: "cursor-desktop", display_name: "Cursor Desktop", kind: "desktop", supported_os: ["windows"], client_presence: "Unknown" },
        { profile_id: "mac-only", client_id: "mac-client", display_name: "Mac Only", kind: "desktop", supported_os: ["macos"], client_presence: "Unknown" },
      ],
      logical_targets: [
        { id: "cli-target", profile_id: "cursor", client_id: "cursor-cli", scope: "global", path: "C:/u/.cursor/skills", marker: "SKILL.md", precedence: "preferred", exists: true, readable: true, writable: true, available: true, physical_id: "cursor-physical" },
        { id: "desktop-target", profile_id: "cursor", client_id: "cursor-desktop", scope: "global", path: "C:\\u\\.cursor\\skills", marker: "SKILL.md", precedence: "preferred", exists: true, readable: true, writable: true, available: true, physical_id: "cursor-physical" },
        { id: "mac-target", profile_id: "mac-only", client_id: "mac-client", scope: "global", path: "C:/u/mac/skills", marker: "SKILL.md", precedence: "preferred", exists: true, readable: true, writable: true, available: true, physical_id: "mac-physical" },
      ],
      physical_targets: [
        { id: "cursor-physical", path: "C:/u/.cursor/skills", exists: true, readable: true, writable: true, case_behavior: "insensitive", logical_target_ids: ["cli-target", "desktop-target"] },
        { id: "mac-physical", path: "C:/u/mac/skills", exists: true, readable: true, writable: true, case_behavior: "sensitive", logical_target_ids: ["mac-target"] },
      ],
    };
    const groups = buildAgentGroups(snapshot, { os: "windows" });
    expect(groups.available).toHaveLength(1);
    expect(groups.available[0]).toMatchObject({ brand: "cursor", cards: [{ kinds: ["desktop", "cli"] }] });
    expect(groups.unavailable).toEqual([]);
  });
});
