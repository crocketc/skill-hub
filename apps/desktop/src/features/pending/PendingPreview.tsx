import { useMemo } from "react";
import { PendingPage } from "./PendingPage";
import type { HandledEntry, PendingFacade, PendingItem, PendingKind } from "./api";

/** Deterministic preview fixtures; DEV-only, never wired into production routes. */
const BASE_ITEMS: PendingItem[] = [
  {
    id: "security_finding:pdf-reader:finding-7",
    subject: "pdf-reader",
    displayName: "pdf-reader",
    kind: "security_finding",
    code: "finding-7",
    message: "pending.messages.securityFinding",
    risk: "high",
    affectedDeployments: 3,
  },
  {
    id: "trial_due:release-notes:trial",
    subject: "release-notes",
    displayName: "release-notes",
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
    displayName: "deploy-toolkit",
    kind: "recovery",
    code: "recovery",
    message: "pending.messages.recovery",
    risk: "low",
  },
  {
    id: "security_finding:web-clipper:finding-2",
    subject: "web-clipper",
    displayName: "web-clipper",
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
    const kinds: PendingKind[] = ["security_finding", "security_alert", "basic_check", "trial_due", "source_update", "conflict", "governance", "governance_followup", "agent_compatibility", "recovery", "ai_setup", "backup_setup", "import_skills"];
    const risks: Array<PendingItem["risk"]> = ["high", "medium", "low", null];
    const kind = kinds[index % kinds.length];
    const skillNumber = Math.floor(index / kinds.length) + 1;
    const subject = kind === "agent_compatibility" ? `agent-${(index % 3) + 1}`
      : kind === "conflict" ? `conflict-${index + 1}`
        : kind === "governance" ? `relation-${index + 1}`
          : kind === "governance_followup" ? `followup-${index + 1}`
            : kind === "recovery" ? `operation-${index + 1}`
              : ["ai_setup", "backup_setup", "import_skills"].includes(kind) ? kind
                : `skill-${skillNumber}`;
    const messageByKind: Record<PendingKind, string> = {
      security_finding: "pending.messages.securityFinding",
      security_alert: "pending.reasons.security_alert.import",
      basic_check: "pending.reasons.basic_check",
      trial_due: "pending.messages.trialDue",
      source_update: "pending.reasons.source_update",
      conflict: "pending.reasons.conflict",
      governance: "pending.reasons.governance",
      governance_followup: "pending.reasons.governance_followup",
      agent_compatibility: "pending.reasons.agent_compatibility",
      recovery: "pending.messages.recovery",
      ai_setup: "pending.reasons.ai_setup",
      backup_setup: "pending.reasons.backup_setup",
      import_skills: "pending.reasons.import_skills",
    };
    const isAgent = kind === "agent_compatibility";
    const sharedDirectory = isAgent && index % 3 !== 0;
    return {
      id: `${kind}:${subject}:preview-${index + 1}`,
      subject,
      displayName: ["security_finding", "security_alert", "basic_check", "trial_due", "source_update"].includes(kind) ? `Skill ${skillNumber}` : undefined,
      kind,
      code: kind,
      message: messageByKind[kind],
      dueDate: kind === "trial_due" ? "2026-12-01" : null,
      risk: risks[index % risks.length],
      affectedDeployments: index % 4,
      recommended: ["ai_setup", "backup_setup", "import_skills"].includes(kind),
      canSnooze: ["trial_due", "source_update", "ai_setup", "backup_setup", "import_skills"].includes(kind),
      href: kind === "agent_compatibility" ? "/__preview/agents/detail?compatibility=1"
        : kind === "ai_setup" ? "/settings?section=networkAi"
          : kind === "backup_setup" ? "/settings?section=dataProtection"
            : kind === "import_skills" ? "/discovery/local" : undefined,
      path: isAgent ? (sharedDirectory ? "C:/Users/demo/.agents/skills" : "C:/Users/demo/.codex/skills") : undefined,
      agentBrand: isAgent ? ["OpenAI", "Anthropic", "Cursor"][index % 3] : undefined,
      agentKinds: isAgent ? [(["desktop", "cli", "ide_extension"] as const)[index % 3]!] : undefined,
      agentDirectoryKey: sharedDirectory ? "verified_physical:fixture-shared-skills" : undefined,
      agentSharedDirectory: sharedDirectory || undefined,
      agentSharedBrands: sharedDirectory ? ["Anthropic", "OpenAI"] : undefined,
      agentSharedBrandKinds: sharedDirectory ? { Anthropic: ["cli"], OpenAI: ["desktop"] } : undefined,
      checkKind: isAgent ? "directory_junction" : undefined,
      sourceRoots: kind === "import_skills" ? ["C:/fixtures/skills"] : undefined,
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
    const failing = previewFlag("actionError");
    const compatibilityItem: PendingItem = {
      id: "work:agent_compatibility:preview-agent:directory_junction", subject: "preview-agent",
      kind: "agent_compatibility", code: "agent_compatibility", message: "pending.reasons.agent_compatibility",
      displayName: "Codex Desktop", agentBrand: "OpenAI", agentKinds: ["desktop"],
      checkKind: "directory_junction", path: "C:/Users/demo/.codex/skills", canSnooze: false,
      href: `/__preview/agents/detail?compatibility=1${failing ? "&actionError=1" : ""}`,
    };
    const items: PendingItem[] = previewFlag("compatibility") ? [compatibilityItem] : previewFlag("empty")
      ? []
      : configuredCount === 0
        ? [...BASE_ITEMS]
        : longList(configuredCount);
    if (previewFlag("setup") && !previewFlag("empty")) items.push(
      { id: "work:import_skills:library:first", subject: "library", kind: "import_skills", code: "import_skills", message: "pending.reasons.import_skills", displayName: "Import your first Skill", recommended: true, href: "/discovery/local", sourceRoots: ["C:/fixtures/skills"] },
      { id: "work:ai_setup:settings:first", subject: "settings", kind: "ai_setup", code: "ai_setup", message: "pending.reasons.ai_setup", displayName: "Configure AI", recommended: true, href: "/settings?section=networkAi" },
    );
    const fail = () => Promise.reject(new Error("library.locked: write permission denied by preview"));
    return {
      list: async () => items.filter((item) => item.kind !== "agent_compatibility" || window.sessionStorage.getItem("preview-agent-compatibility-verified") !== "1"),
      recordCompatibility: async (request) => {
        if (failing) return fail();
        if (request.status !== "unverified") {
          window.sessionStorage.setItem("preview-agent-compatibility-verified", "1");
        }
      },
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
