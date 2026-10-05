import type { PendingItem, PendingKind } from "./api";
import type { AgentKindKey } from "../../ui/AgentPresentation";

export const pendingKinds: PendingKind[] = ["recovery", "conflict", "governance", "governance_followup", "security_finding", "security_alert", "basic_check", "trial_due", "import_skills", "ai_setup", "backup_setup", "source_update", "agent_compatibility"];
export const actionableCount = (items: PendingItem[]) => items.filter((item) => !item.recommended).length;
export const canSnoozePendingItem = (item: PendingItem) => item.canSnooze !== false && ["trial_due", "import_skills", "ai_setup", "backup_setup", "source_update"].includes(item.kind);

export type PendingCategory = "software" | "skill_review" | "relationships" | "agents" | "recovery";
export type PendingReviewIntent = "security_check" | "source_update";
export const pendingCategories: PendingCategory[] = ["software", "skill_review", "relationships", "agents", "recovery"];

export function pendingCategoryForKind(kind: PendingKind): PendingCategory {
  if (["ai_setup", "backup_setup", "import_skills"].includes(kind)) return "software";
  if (["trial_due", "security_finding", "security_alert", "basic_check", "source_update"].includes(kind)) return "skill_review";
  if (["conflict", "governance", "governance_followup"].includes(kind)) return "relationships";
  if (kind === "agent_compatibility") return "agents";
  return "recovery";
}

export interface PendingGroup {
  /** Internal grouping key; never render as text or an accessible label. */
  key: string;
  category: PendingCategory;
  kind?: PendingKind;
  reviewPurpose?: "security_check" | "source_update" | "trial_review";
  subject?: string;
  displayName?: string | null;
  items: PendingItem[];
  count: number;
  objectCount: number;
  /** Readable involved-object names for the collapsed summary; identifiers stay out. */
  objectNames: string[];
  highestRisk?: PendingItem["risk"];
  selectableIds: string[];
  href: string;
  agentBrand?: string;
  agentBrands: string[];
  agentKinds: AgentKindKey[];
  agentSharedBrandKinds: Record<string, AgentKindKey[]>;
  sharedDirectory: boolean;
}

const CATEGORY_ORDER: Record<PendingCategory, number> = {
  software: 0,
  skill_review: 1,
  relationships: 2,
  agents: 3,
  recovery: 4,
};

const RISK_ORDER: Record<NonNullable<PendingItem["risk"]>, number> = { low: 1, medium: 2, high: 3 };

function pendingGroup(item: PendingItem): Pick<PendingGroup, "key" | "category" | "kind" | "reviewPurpose" | "subject" | "href"> {
  switch (item.kind) {
    case "ai_setup": case "backup_setup": case "import_skills":
      return { key: `software:${item.kind}`, category: "software", kind: item.kind, href: item.href ?? pendingDestination(item) };
    case "security_finding": case "security_alert": case "basic_check":
      return {
        key: "skill_review:security_check",
        category: "skill_review",
        reviewPurpose: "security_check",
        href: "/library",
      };
    case "source_update": return { key: "skill_review:source_update", category: "skill_review", reviewPurpose: "source_update", href: "/library" };
    case "trial_due": return { key: "skill_review:trial_review", category: "skill_review", reviewPurpose: "trial_review", href: "/library" };
    case "conflict": return { key: "relationships:conflict", category: "relationships", kind: item.kind, href: "/relationships/decisions" };
    case "governance": return { key: "relationships:governance", category: "relationships", kind: item.kind, href: "/relationships/governance" };
    case "governance_followup": return { key: "relationships:followup", category: "relationships", kind: item.kind, href: "/discovery/local" };
    case "agent_compatibility": {
      const shared = item.agentSharedDirectory === true;
      const key = shared && item.agentDirectoryKey ? item.agentDirectoryKey : item.subject;
      return { key: `agent:${key}`, category: "agents", subject: shared ? undefined : item.subject, href: shared ? "/agents" : `/agents/${encodeURIComponent(item.subject)}` };
    }
    case "recovery": return { key: "recovery", category: "recovery", kind: item.kind, href: "/recovery" };
  }
}

/** Project durable pending facts into compact user work groups without changing their state or counts. */
export function groupPendingItems(items: PendingItem[]): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  for (const item of items) {
    const descriptor = pendingGroup(item);
    let group = groups.get(descriptor.key);
    if (!group) {
      group = {
        ...descriptor,
        displayName: descriptor.reviewPurpose ? undefined : item.displayName,
        items: [],
        count: 0,
        objectCount: 0,
        objectNames: [],
        selectableIds: [],
        agentBrands: [],
        agentKinds: [],
        agentSharedBrandKinds: {},
        sharedDirectory: false,
      };
      groups.set(group.key, group);
    }
    group.items.push(item);
    group.count += 1;
    if (!group.reviewPurpose && item.displayName && (!group.displayName || item.displayName.localeCompare(group.displayName) < 0)) {
      group.displayName = item.displayName;
    }
    if (item.risk && (!group.highestRisk || RISK_ORDER[item.risk] > RISK_ORDER[group.highestRisk])) {
      group.highestRisk = item.risk;
    }
    if (canSnoozePendingItem(item)) group.selectableIds.push(item.id);
    for (const brand of item.agentSharedBrands ?? (item.agentBrand ? [item.agentBrand] : [])) {
      if (!group.agentBrands.includes(brand)) group.agentBrands.push(brand);
      const kinds = item.agentSharedBrandKinds?.[brand] ?? item.agentKinds ?? [];
      group.agentSharedBrandKinds[brand] = [...new Set([...(group.agentSharedBrandKinds[brand] ?? []), ...kinds])];
    }
    for (const kind of item.agentKinds ?? []) {
      if (!group.agentKinds.includes(kind)) group.agentKinds.push(kind);
    }
  }
  for (const group of groups.values()) {
    group.objectCount = new Set(group.items.map((item) => item.subject)).size;
    group.objectNames = [...new Set(group.items.flatMap((item) => item.displayName ? [item.displayName] : []))];
    group.agentBrands.sort((left, right) => left.localeCompare(right));
    group.agentKinds.sort((left, right) => left.localeCompare(right));
    group.agentBrand = group.agentBrands.length === 1 ? group.agentBrands[0] : undefined;
    group.sharedDirectory = group.items.some((item) => item.agentSharedDirectory === true)
      || group.agentKinds.includes("shared_directory");
  }
  const kindOrder = new Map(pendingKinds.map((kind, index) => [kind, index]));
  return [...groups.values()].sort((left, right) => {
    const categoryOrder = CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category];
    if (categoryOrder) return categoryOrder;
    if (left.kind && right.kind) return (kindOrder.get(left.kind) ?? 0) - (kindOrder.get(right.kind) ?? 0);
    return (left.displayName ?? "").localeCompare(right.displayName ?? "");
  });
}

export function pendingCategoryCount(groups: PendingGroup[], category: PendingCategory): number {
  return groups.filter((group) => group.category === category).reduce((total, group) => total + group.count, 0);
}

/** Skill subjects that can enter an existing library batch workflow; high-risk findings stay individual. */
export function pendingReviewSkillIds(items: PendingItem[], intent: PendingReviewIntent): string[] {
  const eligible = items.filter((item) => intent === "source_update"
    ? item.kind === "source_update"
    : item.kind === "basic_check" || (item.kind === "security_finding" && item.risk !== "high"));
  return [...new Set(eligible.map((item) => item.subject).filter(Boolean))];
}

/** Preserve the current pending filters when another workbench links back here. */
export function pendingReturnHref(currentSearch: string, category: PendingCategory | "all", searchText: string, specificKind: PendingKind | "all"): string {
  const params = new URLSearchParams(currentSearch);
  params.delete("category");
  params.delete("search");
  if (category !== "all") params.set("category", category);
  if (searchText.trim()) params.set("search", searchText.trim());
  if (specificKind === "all") params.delete("kind");
  else params.set("kind", specificKind);
  return `/pending${params.size ? `?${params}` : ""}`;
}

export function pendingDestination(item: PendingItem): string {
  const subject = encodeURIComponent(item.subject ?? "");
  switch (item.kind) {
    case "agent_compatibility": return `/agents/${subject}`;
    case "security_finding": case "security_alert": case "basic_check": {
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
