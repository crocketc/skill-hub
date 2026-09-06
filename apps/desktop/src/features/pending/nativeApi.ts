import { executeCommand, queryApplication, type PendingItem as NativePendingItem } from "../../api/bindings";
import type { HandledEntry, PendingFacade, PendingItem } from "./api";

const SAVED_VIEW_KEY = "pending.view.kind";
const SAVED_VIEW_KINDS = ["all", "trial_due", "security_finding", "recovery"];

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

export const nativePendingFacade: PendingFacade = {
  async list() {
    const result = await queryApplication({ type: "list_pending_items", payload: null });
    if (result.type !== "pending_items") {
      throw new Error("list_pending_items returned an unexpected native result.");
    }
    return result.payload.map(pendingItem);
  },
  async resolve(item) {
    if (item.kind === "security_finding") {
      const versionId = await currentVersion(item.subject);
      const result = await executeCommand({ type: "set_finding_disposition", payload: { skill_id: item.subject, version_id: versionId, kind: "basic", finding_id: item.code, disposition: "acknowledged", high_risk_confirmed: true } });
      if (result.type !== "basic_check_result") throw new Error("pending resolution returned an unexpected result");
      return;
    }
    if (item.kind === "recovery") {
      await executeCommand({ type: "acknowledge_recovery", payload: { operation_id: item.subject } });
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
    await executeCommand({ type: "acknowledge_recovery", payload: { operation_id: item.subject } });
  },
  async defer(items, days, reason) {
    const deferUntil = localDateDaysFromNow(days);
    for (const item of items) {
      await createPendingIgnoreRule(item, reason, deferUntil);
    }
  },
  async ignore(items, reason) {
    for (const item of items) {
      await createPendingIgnoreRule(item, reason, null);
    }
  },
  async listHandled() {
    const result = await queryApplication({ type: "list_ignore_rules" });
    if (result.type !== "ignore_rules") {
      throw new Error("list_ignore_rules returned an unexpected native result.");
    }
    return result.payload
      .filter((rule): rule is typeof rule & { subject: { type: "exact_pending"; value: string } } => rule.subject.type === "exact_pending")
      .map((rule): HandledEntry => ({
        id: rule.id,
        pendingId: rule.subject.value,
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
