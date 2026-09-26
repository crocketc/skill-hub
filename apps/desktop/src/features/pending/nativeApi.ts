import { executeCommand, queryApplication, type PendingItem as NativePendingItem } from "../../api/bindings";
import type { HandledEntry, PendingFacade, PendingItem } from "./api";

const SAVED_VIEW_KEY = "pending.view.kind";
const SAVED_VIEW_KINDS = ["all", "trial_due", "security_finding", "recovery", "conflict", "governance"];

async function skillNames(ids: string[]): Promise<Map<string, string | null>> {
  return new Map(await Promise.all([...new Set(ids)].map(async (id) => {
    // Deleted/unavailable object names must never fall back to displaying UUIDs.
    try {
      const result = await queryApplication({ type: "get_skill", payload: { skill_id: id } });
      return [id, result.type === "skill" ? result.payload.display_name : null] as const;
    } catch {
      return [id, null] as const;
    }
  })));
}

function requireSnoozable(items: PendingItem[]) {
  if (items.some((item) => item.canSnooze === false || ["recovery", "conflict", "governance"].includes(item.kind))) {
    throw new Error("This item must be handled at its source.");
  }
}

function pendingItem(item: NativePendingItem): PendingItem {
  return {
    id: `${item.kind}:${item.subject}:${item.code}`,
    subject: item.subject,
    kind: item.kind,
    code: item.code,
    message: item.message_code ?? item.code,
    dueDate: item.due_date ?? null,
    risk: item.risk ?? null,
    affectedDeployments: item.affected_deployments ?? null,
  };
}

/** 本地时区的“今天 + days”，格式 YYYY-MM-DD（与原生 defer_until 契约一致）。 */
function localDateDaysFromNow(days: number): string {
  const due = new Date();
  due.setDate(due.getDate() + days);
  const month = String(due.getMonth() + 1).padStart(2, "0");
  const day = String(due.getDate()).padStart(2, "0");
  return `${due.getFullYear()}-${month}-${day}`;
}

async function currentVersion(skillId: string): Promise<string> {
  const result = await queryApplication({ type: "get_skill", payload: { skill_id: skillId } });
  if (result.type !== "skill" || !result.payload.current_version) throw new Error("pending item has no current Skill version");
  return result.payload.current_version;
}

async function createPendingIgnoreRule(item: PendingItem, reason: string, deferUntil: string | null): Promise<void> {
  const result = await executeCommand({
    type: "create_ignore_rule",
    payload: { subject: { type: "exact_pending", value: item.id }, reason, defer_until: deferUntil },
  });
  if (result.type !== "ignore_rule") {
    throw new Error("create_ignore_rule returned an unexpected native result.");
  }
}

/**
 * 处置一条「需要恢复」的待办：走 `resolve_recovery` 的回滚动作，与恢复页一致。
 * `acknowledge_recovery` 在应用层没有实现分支，用它只会拿到 `internal.error`，
 * 待办项永远处置不掉。
 */
async function resolveRecoverableOperation(operationId: string): Promise<void> {
  const result = await executeCommand({ type: "resolve_recovery", payload: { operation_id: operationId, action: "rollback_operation" } });
  if (result.type !== "operation_summary") throw new Error("recovery resolution returned an unexpected result");
}

export const nativePendingFacade: PendingFacade = {
  async list() {
    const [result, conflicts, governance, recovery] = await Promise.all([
      queryApplication({ type: "list_pending_items", payload: null }),
      queryApplication({ type: "get_conflict_workspace", payload: null }),
      queryApplication({ type: "list_relation_governance", payload: { filters: {} } }),
      queryApplication({ type: "list_recovery_candidates" }),
    ]);
    if (result.type !== "pending_items" || conflicts.type !== "conflict_workspace"
      || governance.type !== "relation_governance_ledger" || recovery.type !== "recovery_candidates") {
      throw new Error("Unified pending sources returned an unexpected result.");
    }
    const names = await skillNames([
      ...result.payload.filter((item) => item.kind !== "recovery").map((item) => item.subject),
      ...conflicts.payload.cases.flatMap((item) => item.case.member_skill_ids),
    ]);
    const items: PendingItem[] = result.payload.filter((item) => item.kind !== "recovery").map((item) => ({
      ...pendingItem(item), displayName: names.get(item.subject) ?? null,
      message: `pending.reasons.${item.kind}`,
      href: `/library/${encodeURIComponent(item.subject)}${item.kind === "security_finding" ? "/security" : ""}`,
    }));
    for (const { case: conflict } of conflicts.payload.cases) {
      const labels = [...new Set(conflict.member_skill_ids.flatMap((id) => names.get(id) ? [names.get(id)!] : []))];
      items.push({
        id: `conflict:${conflict.conflict_id}`, subject: conflict.conflict_id,
        kind: "conflict", code: "conflict", message: "pending.reasons.conflict",
        displayName: labels.join(" / ") || null, canSnooze: false,
        href: `/relationships/decisions?${new URLSearchParams({ conflictId: conflict.conflict_id })}`,
      });
    }
    for (const row of governance.payload.rows) {
      if (!row.relation.fact.active || !["needs_validation", "needs_attention", "blocked"].includes(row.status)) continue;
      const fact = row.relation.fact;
      items.push({
        id: `governance:${fact.relation_id}`, subject: fact.relation_id,
        kind: "governance", code: row.status, message: `pending.reasons.${row.status}`,
        displayName: row.skill_display_name, canSnooze: false,
        path: row.relation.kind === "source_copy" ? row.relation.fact.source_path : row.relation.fact.path,
        href: `/relationships/governance?${new URLSearchParams({ relationId: fact.relation_id, ...(fact.skill_id ? { skillId: fact.skill_id } : {}) })}`,
      });
    }
    for (const candidate of recovery.payload) {
      items.push({
        id: `recovery:${candidate.operation_id}`, subject: candidate.operation_id,
        kind: "recovery", code: "needs_recovery", message: "pending.reasons.recovery",
        displayName: null, canSnooze: false, href: `/recovery?${new URLSearchParams({ operationId: candidate.operation_id })}`,
      });
    }
    const priority = { recovery: 0, conflict: 1, governance: 2, security_finding: 3, trial_due: 4 };
    return [...new Map(items.map((item) => [item.id, item])).values()]
      .sort((a, b) => priority[a.kind] - priority[b.kind] || a.id.localeCompare(b.id));
  },
  async resolve(item) {
    if (item.kind === "conflict" || item.kind === "governance") throw new Error("Open the item's handling page.");
    if (item.kind === "security_finding") {
      const versionId = await currentVersion(item.subject);
      const result = await executeCommand({ type: "set_finding_disposition", payload: { skill_id: item.subject, version_id: versionId, kind: "basic", finding_id: item.code, disposition: "acknowledged", high_risk_confirmed: true } });
      if (result.type !== "basic_check_result") throw new Error("pending resolution returned an unexpected result");
      return;
    }
    if (item.kind === "recovery") {
      await resolveRecoverableOperation(item.subject);
      return;
    }
    await executeCommand({ type: "set_lifecycle", payload: { skill_id: item.subject, lifecycle: "Archived" } });
  },
  async recheck(item) {
    const versionId = await currentVersion(item.subject);
    const result = await executeCommand({ type: "recheck_basic", payload: { skill_id: item.subject, version_id: versionId } });
    if (result.type !== "basic_check_result") throw new Error("pending recheck returned an unexpected result");
  },
  async convert(item) {
    await executeCommand({ type: "set_lifecycle", payload: { skill_id: item.subject, lifecycle: "Normal" } });
  },
  async remove(item) {
    await nativePendingFacade.resolve(item);
  },
  async recover(item) {
    await resolveRecoverableOperation(item.subject);
  },
  async defer(items, days, reason) {
    requireSnoozable(items);
    const deferUntil = localDateDaysFromNow(days);
    await Promise.all(items.map((item) => createPendingIgnoreRule(item, reason, deferUntil)));
  },
  async ignore(items, reason) {
    requireSnoozable(items);
    await Promise.all(items.map((item) => createPendingIgnoreRule(item, reason, null)));
  },
  async listHandled() {
    const result = await queryApplication({ type: "list_ignore_rules" });
    if (result.type !== "ignore_rules") {
      throw new Error("list_ignore_rules returned an unexpected native result.");
    }
    const rules = result.payload
      .filter((rule): rule is typeof rule & { subject: { type: "exact_pending"; value: string } } => rule.subject.type === "exact_pending");
    const subjectOf = (value: string) => /^(?:trial_due|security_finding):([^:]+):/.exec(value)?.[1];
    const names = await skillNames(rules.flatMap((rule) => {
      const id = subjectOf(rule.subject.value);
      return id ? [id] : [];
    }));
    return rules
      .map((rule): HandledEntry => ({
        id: rule.id,
        pendingId: rule.subject.value,
        displayName: names.get(subjectOf(rule.subject.value) ?? "") ?? null,
        reason: rule.reason,
        createdAt: rule.created_at,
        deferUntil: rule.defer_until,
      }));
  },
  async unignore(ruleId) {
    const result = await executeCommand({ type: "remove_ignore_rule", payload: { rule_id: ruleId } });
    if (result.type !== "operation_summary") {
      throw new Error("remove_ignore_rule returned an unexpected native result.");
    }
  },
  async loadSavedView() {
    const result = await queryApplication({ type: "get_ui_preference", payload: { key: SAVED_VIEW_KEY } });
    if (result.type !== "ui_preference") {
      throw new Error("get_ui_preference returned an unexpected native result.");
    }
    const raw = result.payload.value_json;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { kind?: unknown };
      return typeof parsed?.kind === "string" && SAVED_VIEW_KINDS.includes(parsed.kind) ? parsed.kind : null;
    } catch {
      return null;
    }
  },
  async saveSavedView(kind) {
    await executeCommand({
      type: "set_ui_preference",
      payload: { key: SAVED_VIEW_KEY, value_json: JSON.stringify({ kind }) },
    });
  },
};
