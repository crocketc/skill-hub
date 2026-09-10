import { useMemo } from "react";
import { PendingPage } from "./PendingPage";
import type { HandledEntry, PendingFacade, PendingItem, PendingKind } from "./api";

/** Deterministic preview fixtures; DEV-only, never wired into production routes. */
const BASE_ITEMS: PendingItem[] = [
  {
    id: "security_finding:pdf-reader:finding-7",
    subject: "pdf-reader",
    kind: "security_finding",
    code: "finding-7",
    message: "pending.messages.securityFinding",
    risk: "high",
    affectedDeployments: 3,
  },
  {
    id: "trial_due:release-notes:trial",
    subject: "release-notes",
    kind: "trial_due",
    code: "trial",
    message: "pending.messages.trialDue",
    dueDate: "2026-09-30",
    risk: "medium",
    affectedDeployments: 2,
  },
  {
    id: "recovery:op-deploy-9:recovery",
    subject: "deploy-toolkit",
    kind: "recovery",
    code: "recovery",
    message: "pending.messages.recovery",
    risk: "low",
  },
  {
    id: "security_finding:web-clipper:finding-2",
    subject: "web-clipper",
    kind: "security_finding",
    code: "finding-2",
    message: "pending.messages.securityFinding",
    risk: "low",
    affectedDeployments: 1,
  },
];

const HANDLED: HandledEntry[] = [
  { id: "rule-1", pendingId: "security_finding:legacy-tool:finding-1", reason: "Deferred 7 days; remind me when it is due", createdAt: "2026-09-08T08:00:00Z", deferUntil: "2026-09-15" },
  { id: "rule-2", pendingId: "trial_due:old-importer:trial", reason: "Permanently ignored via handled history", createdAt: "2026-09-01T10:00:00+08:00", deferUntil: null },
];

function previewNumber(fallback: number): number {
  const raw = new URLSearchParams(window.location.search).get("items");
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function previewFlag(name: string): boolean {
  return new URLSearchParams(window.location.search).get(name) === "1";
}

function longList(count: number): PendingItem[] {
  return Array.from({ length: count }, (_, index) => {
    const kinds: PendingKind[] = ["security_finding", "trial_due", "recovery"];
    const risks: Array<PendingItem["risk"]> = ["high", "medium", "low", null];
    const kind = kinds[index % kinds.length];
    return {
      id: `${kind}:skill-${index + 1}:preview`,
      subject: `skill-${index + 1}`,
      kind,
      code: kind,
      message: kind === "security_finding"
        ? "pending.messages.securityFinding"
        : kind === "trial_due"
          ? "pending.messages.trialDue"
          : "pending.messages.recovery",
      dueDate: kind === "trial_due" ? "2026-12-01" : null,
      risk: risks[index % risks.length],
      affectedDeployments: index % 4,
    } satisfies PendingItem;
  });
}

/**
 * DEV-only preview for /__preview/pending.
 * Query knobs: ?items=60 seeds a 60-item list, ?actionError=1 fails every
 * action, ?empty=1 renders the empty state. No disk, network, or vendor.
 */
export function PendingPreview() {
  const facade = useMemo<PendingFacade>(() => {
    const configuredCount = previewNumber(0);
    const items = previewFlag("empty")
      ? []
      : configuredCount === 0
        ? BASE_ITEMS
        : longList(configuredCount);
    const failing = previewFlag("actionError");
    const fail = () => Promise.reject(new Error("library.locked: write permission denied by preview"));
    return {
      list: async () => items,
      resolve: async () => undefined,
      recheck: failing ? fail : async () => undefined,
      convert: failing ? fail : async () => undefined,
      remove: async () => undefined,
      recover: failing ? fail : async () => undefined,
      defer: failing ? fail : async () => undefined,
      ignore: failing ? fail : async () => undefined,
      listHandled: async () => (previewFlag("empty") ? [] : HANDLED),
      unignore: failing ? fail : async () => undefined,
      loadSavedView: async () => null,
      saveSavedView: async () => undefined,
    };
  }, []);
  return <PendingPage facade={facade} />;
}
