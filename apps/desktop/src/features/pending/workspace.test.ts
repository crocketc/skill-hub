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
});

it("keeps one destination summary per relationship workbench and one recovery entry", () => {
  const groups = groupPendingItems([
    { id: "conflict-a", subject: "c-a", kind: "conflict" } as PendingItem,
    { id: "conflict-b", subject: "c-b", kind: "conflict" } as PendingItem,
    { id: "governance", subject: "r-1", kind: "governance" } as PendingItem,
    { id: "followup", subject: "t-1", kind: "governance_followup" } as PendingItem,
    { id: "recovery-a", subject: "op-a", kind: "recovery" } as PendingItem,
    { id: "recovery-b", subject: "op-b", kind: "recovery" } as PendingItem,
  ]);

  expect(groups.map((group) => [group.category, group.count, group.href])).toEqual([
    ["relationships", 2, "/relationships/decisions"],
    ["relationships", 1, "/relationships/governance"],
    ["relationships", 1, "/discovery/local"],
    ["recovery", 2, "/recovery"],
  ]);
  expect(groups.every((group) => group.selectableIds.length === 0)).toBe(true);
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
