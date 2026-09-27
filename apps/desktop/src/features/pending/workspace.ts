import type { PendingItem, PendingKind } from "./api";

export const pendingKinds: PendingKind[] = ["recovery", "conflict", "governance", "governance_followup", "security_finding", "basic_check", "trial_due", "import_skills", "ai_setup", "backup_setup", "source_update"];
export const actionableCount = (items: PendingItem[]) => items.filter((item) => !item.recommended).length;
export const canSnoozePendingItem = (item: PendingItem) => item.canSnooze !== false && ["trial_due", "import_skills", "ai_setup", "backup_setup", "source_update"].includes(item.kind);

export function pendingDestination(item: PendingItem): string {
  const subject = encodeURIComponent(item.subject ?? "");
  switch (item.kind) {
    case "security_finding": case "basic_check": {
      const params = new URLSearchParams();
      if (item.versionId) params.set("version", item.versionId);
      if (item.checkKind) params.set("kind", item.checkKind);
      if (item.findingId) params.set("finding", item.findingId);
      return `/library/${subject}/security${params.size ? `?${params}` : ""}`;
    }
    case "conflict": return `/relationships/decisions?${new URLSearchParams({ conflictId: item.subject })}`;
    case "governance_followup": return `/discovery/local?${new URLSearchParams({ task: item.subject })}`;
    case "governance": return `/relationships/governance?${new URLSearchParams({ relationId: item.subject })}`;
    case "recovery": return `/recovery?${new URLSearchParams({ operationId: item.subject })}`;
    case "import_skills": return "/discovery/local";
    case "ai_setup": return "/settings?section=networkAi";
    case "backup_setup": return "/settings?section=dataProtection";
    case "source_update": return `/library/${subject}#versions`;
    default: return `/library/${subject}`;
  }
}

export function relatedPendingHref(subjects: string[], kind?: PendingKind): string {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  [...new Set(subjects)].forEach((subject) => params.append("subject", subject));
  return `/pending${params.size ? `?${params}` : ""}`;
}
export function governanceDestination(subjects: string[]): string {
  return subjects.length === 1 ? `/relationships/governance?${new URLSearchParams({ relationId: subjects[0] })}` : relatedPendingHref(subjects, "governance");
}
