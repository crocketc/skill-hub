import { executeCommand, queryApplication } from "../../api/bindings";
import { pendingDestination, pendingKinds, canSnoozePendingItem } from "./workspace";
import type { HandledEntry, PendingFacade, PendingItem } from "./api";

const SAVED_VIEW_KEY = "pending.view.kind";
const SAVED_VIEW_KINDS = ["all", ...pendingKinds];

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
  if (items.some((item) => !canSnoozePendingItem(item))) {
    throw new Error("This item must be handled at its source.");
  }
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
  const result = await executeCommand(item.id.startsWith("work:") ? {
    type: "dismiss_pending_work", payload: { item_id: item.id, reason, defer_until: deferUntil },
  } : {
    type: "create_ignore_rule", payload: { subject: { type: "exact_pending", value: item.id }, reason, defer_until: deferUntil },
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
  async workspace() {
    const result = await queryApplication({ type: "get_pending_workspace" });
    if (result.type !== "pending_workspace") throw new Error("Unexpected pending workspace result.");
    const items = result.payload.items.map((work): PendingItem => {
      const item: PendingItem = {
        id: work.id, subject: work.subject, kind: work.kind, code: work.kind,
        message: work.message_code, displayName: work.display_name,
        recommended: work.recommended, canSnooze: work.can_defer && work.can_ignore,
        versionId: work.version_id ?? undefined, findingId: work.finding_id ?? undefined,
        checkKind: work.check_kind ?? undefined, path: work.path ?? undefined,
        dueDate: work.due_date, risk: work.risk,
        sourceRoots: work.source_roots, canConfirm: work.can_confirm,
      };
      return { ...item, href: pendingDestination(item) };
    });
    return { items, unavailableSources: result.payload.unavailable_sources };
  },
  async list() { return (await nativePendingFacade.workspace!()).items; },
  async confirm(item, reason) {
    if (!item.canConfirm) throw new Error("This item requires its handling workflow.");
    const result = await executeCommand({ type: "confirm_pending_work", payload: { item_id: item.id, reason } });
    if (result.type !== "operation_summary") throw new Error("Unexpected confirmation result.");
  },
  async resolve(item) {
    if (item.kind === "conflict" || item.kind === "governance") throw new Error("Open the item's handling page.");
    if (item.kind !== "trial_due" && item.kind !== "recovery") throw new Error("Open the item's handling page.");
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
    const [result, confirmations] = await Promise.all([
      queryApplication({ type: "list_ignore_rules" }), queryApplication({ type: "list_pending_confirmations" }),
    ]);
    if (confirmations.type !== "pending_confirmations") throw new Error("Unexpected confirmation history result.");
    if (result.type !== "ignore_rules") {
      throw new Error("list_ignore_rules returned an unexpected native result.");
    }
    const rules = result.payload
      .filter((rule): rule is typeof rule & { subject: { type: "exact_pending"; value: string } } => rule.subject.type === "exact_pending");
    const subjectOf = (value: string) => /^(?:work:)?(?:trial_due|security_finding|basic_check|source_update):([^:]+):/.exec(value)?.[1];
    const names = await skillNames(rules.flatMap((rule) => {
      const id = subjectOf(rule.subject.value);
      return id ? [id] : [];
    }));
    return [...confirmations.payload.map((entry): HandledEntry => ({
      id: entry.item_id, pendingId: entry.item_id, reason: entry.reason, createdAt: new Date(Number(entry.confirmed_at) * 1000).toISOString(), deferUntil: null, confirmed: true,
    })), ...rules
      .map((rule): HandledEntry => ({
        id: rule.id,
        pendingId: rule.subject.value,
        displayName: names.get(subjectOf(rule.subject.value) ?? "") ?? null,
        reason: rule.reason,
        createdAt: rule.created_at,
        deferUntil: rule.defer_until,
      }))];
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
