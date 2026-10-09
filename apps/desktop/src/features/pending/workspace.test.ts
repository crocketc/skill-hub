import { expect, it } from "vitest";
import { pendingDestination, actionableCount, groupPendingItems, pendingReviewSkillIds, pendingReturnHref } from "./workspace";
import type { PendingItem } from "./api";

it("counts unresolved work but excludes optional setup recommendations", () => {
  expect(actionableCount([{ recommended: true }, { recommended: false }, {}] as PendingItem[])).toBe(2);
});

it("links a finding to its exact version, check and finding", () => {
  expect(pendingDestination({ kind: "security_finding", subject: "skill", versionId: "v2", findingId: "f7", checkKind: "llm" } as PendingItem))
    .toBe("/library/skill/security?version=v2&kind=llm&finding=f7");
});

it("routes setup to the matching settings section", () => {
  expect(pendingDestination({ kind: "ai_setup" } as PendingItem)).toBe("/settings?section=networkAi");
  expect(pendingDestination({ kind: "backup_setup" } as PendingItem)).toBe("/settings?section=dataProtection");
});

it("groups setup suggestions by the action they share and keeps exact eligible ids", () => {
  const groups = groupPendingItems([
    { id: "ai-1", subject: "settings", kind: "ai_setup", recommended: true, canSnooze: true } as PendingItem,
    { id: "ai-2", subject: "settings", kind: "ai_setup", recommended: true, canSnooze: true } as PendingItem,
    { id: "backup", subject: "library", kind: "backup_setup", recommended: true, canSnooze: true } as PendingItem,
  ]);

  expect(groups.map((group) => [group.category, group.count, group.objectCount])).toEqual([
    ["software", 2, 1],
    ["software", 1, 1],
  ]);
  expect(groups[0]?.selectableIds).toEqual(["ai-1", "ai-2"]);
  expect(groups[0]?.href).toBe("/settings?section=networkAi");
});

it("aggregates skill reviews by work purpose, preserves risk and keeps exact item selections", () => {
  const groups = groupPendingItems([
    { id: "check", subject: "skill-a", displayName: "Skill A", kind: "basic_check", canSnooze: false } as PendingItem,
    { id: "high", subject: "skill-a", displayName: "Skill A", kind: "security_finding", risk: "high", canSnooze: false } as PendingItem,
    { id: "trial", subject: "skill-a", displayName: "Skill A", kind: "trial_due", risk: "medium", canSnooze: true } as PendingItem,
    { id: "other", subject: "skill-b", displayName: "Skill B", kind: "source_update", canSnooze: true } as PendingItem,
  ]);

  expect(groups).toHaveLength(3);
  expect(groups[0]).toMatchObject({
    category: "skill_review",
    reviewPurpose: "security_check",
    count: 2,
    objectCount: 1,
    highestRisk: "high",
    selectableIds: [],
  });
  expect(groups[0]?.href).toBe("/library");
  expect(groups[1]).toMatchObject({ reviewPurpose: "trial_review", count: 1, selectableIds: ["trial"] });
  expect(groups[2]).toMatchObject({ reviewPurpose: "source_update", count: 1, selectableIds: ["other"] });
});

it("keeps many Skills under a small number of review-purpose entrances", () => {
  const items = Array.from({ length: 50 }, (_, index) => ({
    id: `finding-${index}`,
    subject: `skill-${index}`,
    displayName: `Skill ${index}`,
    kind: index % 2 === 0 ? "security_finding" : "basic_check",
    risk: index % 5 === 0 ? "high" : "low",
    message: `Finding reason ${index}`,
  })) as PendingItem[];
  items.push(
    { id: "source-a", subject: "skill-a", kind: "source_update" } as PendingItem,
    { id: "source-b", subject: "skill-b", kind: "source_update" } as PendingItem,
    { id: "trial-a", subject: "skill-a", kind: "trial_due" } as PendingItem,
  );

  const groups = groupPendingItems(items);
  expect(groups).toHaveLength(3);
  expect(groups.map((group) => [group.reviewPurpose, group.count, group.objectCount])).toEqual([
    ["security_check", 50, 50],
    ["source_update", 2, 2],
    ["trial_review", 1, 1],
  ]);
  // 折叠摘要点名可读对象名（按事项顺序去重），不携带任何技术标识。
  expect(groups[0]?.objectNames.slice(0, 3)).toEqual(["Skill 0", "Skill 1", "Skill 2"]);
  // 没有可读名称的对象不进入摘要，也不伪造名称。
  expect(groups[2]?.objectNames).toEqual([]);
});

it("collects readable object names for the collapsed summary without identifiers", () => {
  const groups = groupPendingItems([
    { id: "medium-a", subject: "skill-a", displayName: "PDF Reader", kind: "security_finding", risk: "medium" } as PendingItem,
    { id: "basic-b", subject: "skill-b", displayName: "PDF Reader Pro", kind: "basic_check" } as PendingItem,
    { id: "basic-b2", subject: "skill-b", displayName: "PDF Reader Pro", kind: "basic_check" } as PendingItem,
    { id: "no-name", subject: "skill-c", kind: "basic_check" } as PendingItem,
  ]);

  const securityGroup = groups.find((group) => group.reviewPurpose === "security_check");
  expect(securityGroup?.objectNames).toEqual(["PDF Reader", "PDF Reader Pro"]);
  expect(securityGroup?.highestRisk).toBe("medium");
});

it("keeps relationship pending groups at their stable issue or relation identity", () => {
  const groups = groupPendingItems([
    { id: "conflict-a", subject: "c-a", kind: "conflict" } as PendingItem,
    { id: "conflict-b", subject: "c-b", kind: "conflict" } as PendingItem,
    { id: "problem-a", subject: "p-a", kind: "governance", message: "pending.reasons.environment_problem.same_skill", governanceContext: { agent_id: "agent-a", problem_id: "problem-a", return_to: "/pending" } } as PendingItem,
    { id: "problem-b", subject: "p-b", kind: "governance", governanceContext: { agent_id: "agent-b", project_id: "project-b", problem_id: "problem-b", return_to: "/pending" } } as PendingItem,
    { id: "governance-a", subject: "r-1", kind: "governance" } as PendingItem,
    { id: "governance-b", subject: "r-2", kind: "governance" } as PendingItem,
    { id: "followup", subject: "t-1", kind: "governance_followup" } as PendingItem,
    { id: "recovery-a", subject: "op-a", kind: "recovery" } as PendingItem,
    { id: "recovery-b", subject: "op-b", kind: "recovery" } as PendingItem,
  ]);

  expect(groups.filter((group) => group.kind === "conflict").map((group) => [group.count, group.href])).toEqual([
    [1, "/relationships/decisions?conflictId=c-a"],
    [1, "/relationships/decisions?conflictId=c-b"],
  ]);
  expect(groups.filter((group) => group.kind === "governance").map((group) => [group.count, group.href]).sort()).toEqual([
    [1, "/relationships/governance?agent_id=agent-a&problem_id=problem-a&return_to=%2Fpending"],
    [1, "/relationships/governance?agent_id=agent-b&project_id=project-b&problem_id=problem-b&return_to=%2Fpending"],
    [1, "/relationships/governance?relationId=r-1"],
    [1, "/relationships/governance?relationId=r-2"],
  ].sort());
  expect(groups.find((group) => group.key.includes("problem:problem-a"))?.titleKey)
    .toBe("pending.environmentProblemTitles.sameSkill");
  expect(groups.filter((group) => group.category === "recovery").map((group) => group.count)).toEqual([2]);
  expect(groups.every((group) => group.selectableIds.length === 0)).toBe(true);
});

it("sends a governance item to the shared current-problem route with complete context", () => {
  expect(pendingDestination({
    kind: "governance",
    subject: "problem-1",
    governanceContext: {
      agent_id: "agent:codex",
      project_id: "project:one",
      problem_id: "env:same_skill:abc",
      relation_id: "managed:dep-1",
      skill_id: "skill:pdf",
      return_to: "/pending?category=relationships",
    },
  } as PendingItem)).toBe(
    "/relationships/governance?agent_id=agent%3Acodex&project_id=project%3Aone&problem_id=env%3Asame_skill%3Aabc&relation_id=managed%3Adep-1&skill_id=skill%3Apdf&return_to=%2Fpending%3Fcategory%3Drelationships",
  );
});

it("keeps an incomplete pending issue link on the pending list", () => {
  expect(pendingDestination({
    kind: "governance",
    subject: "problem-1",
    governanceContext: { agent_id: "agent:codex", return_to: "/pending" },
  } as PendingItem)).toBe("/pending");
});

it("merges Agent compatibility modes by target and keeps the target presentation facts", () => {
  const groups = groupPendingItems([
    { id: "copy", subject: "target-a", displayName: "CodeBuddy", kind: "agent_compatibility", agentBrand: "CodeBuddy", agentKinds: ["cli"], checkKind: "managed_copy", canSnooze: false } as PendingItem,
    { id: "link", subject: "target-a", displayName: "CodeBuddy", kind: "agent_compatibility", agentBrand: "CodeBuddy", agentKinds: ["cli"], checkKind: "symbolic_link", canSnooze: false } as PendingItem,
  ]);

  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    category: "agents",
    count: 2,
    objectCount: 1,
    agentBrand: "CodeBuddy",
    agentKinds: ["cli"],
    href: "/agents/target-a",
  });
  expect(groups[0]?.selectableIds).toEqual([]);
});

it("merges member work into one shared-directory entity only when the directory identity says it is shared", () => {
  const groups = groupPendingItems([
    { id: "openai", subject: "target-openai", kind: "agent_compatibility", code: "agent_compatibility", message: "pending.reasons.agent_compatibility", agentDirectoryKey: "verified_physical:dir-a", agentSharedDirectory: true, agentSharedBrands: ["OpenAI", "Anthropic"], agentSharedBrandKinds: { OpenAI: ["desktop"], Anthropic: ["cli"] } },
    { id: "anthropic", subject: "target-anthropic", kind: "agent_compatibility", code: "agent_compatibility", message: "pending.reasons.agent_compatibility", agentDirectoryKey: "verified_physical:dir-a", agentSharedDirectory: true, agentSharedBrands: ["OpenAI", "Anthropic"], agentSharedBrandKinds: { OpenAI: ["desktop"], Anthropic: ["cli"] } },
    { id: "other", subject: "target-other", kind: "agent_compatibility", code: "agent_compatibility", message: "pending.reasons.agent_compatibility", agentDirectoryKey: "verified_physical:dir-b", agentSharedDirectory: false, agentBrand: "OpenAI", agentKinds: ["desktop"] },
  ]);

  expect(groups).toHaveLength(2);
  expect(groups[0]).toMatchObject({
    category: "agents",
    sharedDirectory: true,
    objectCount: 2,
    count: 2,
    agentBrands: ["Anthropic", "OpenAI"],
    agentSharedBrandKinds: { OpenAI: ["desktop"], Anthropic: ["cli"] },
    href: "/agents",
  });
  expect(groups[1]).toMatchObject({ sharedDirectory: false, objectCount: 1, href: "/agents/target-other" });
});

it("builds batch review selections from real Skill subjects and excludes high-risk findings", () => {
  const items = [
    { id: "basic-a", subject: "skill-a", kind: "basic_check" },
    { id: "medium-a", subject: "skill-a", kind: "security_finding", risk: "medium" },
    { id: "high-b", subject: "skill-b", kind: "security_finding", risk: "high" },
    { id: "source-b", subject: "skill-b", kind: "source_update" },
  ] as PendingItem[];

  expect(pendingReviewSkillIds(items, "security_check")).toEqual(["skill-a"]);
  expect(pendingReviewSkillIds(items, "source_update")).toEqual(["skill-b"]);
});

it("keeps the pending category, search, related subjects and real kind query on library return", () => {
  expect(pendingReturnHref("?subject=skill-a&kind=trial_due", "skill_review", "pdf reader", "all"))
    .toBe("/pending?subject=skill-a&category=skill_review&search=pdf+reader");
  expect(pendingReturnHref("", "all", "", "security_finding"))
    .toBe("/pending?kind=security_finding");
});
