import { expect, it } from "vitest";
import { pendingDestination, actionableCount } from "./workspace";
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
