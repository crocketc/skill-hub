import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { nativePendingFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({ queryApplication: vi.fn(), executeCommand: vi.fn() }));

const query = vi.mocked(queryApplication);

beforeEach(() => {
  query.mockReset();
  vi.mocked(executeCommand).mockReset();
});

it("maps derived pending work to stable page identities", async () => {
  query.mockResolvedValue({ type: "pending_workspace", payload: { unavailable_sources: [], items: [{
    id: "work:security_finding:pdf-reader:v1:finding-7", subject: "pdf-reader", kind: "security_finding",
    message_code: "pending.reasons.security_finding", display_name: "PDF Reader", can_defer: false, can_ignore: false,
    recommended: false, can_confirm: false, version_id: "v1", finding_id: "finding-7", check_kind: "basic", risk: "high", path: null, due_date: null, source_roots: [],
  }] } });
  await expect(nativePendingFacade.list()).resolves.toEqual([{
    id: "work:security_finding:pdf-reader:v1:finding-7", subject: "pdf-reader", kind: "security_finding", code: "security_finding",
    message: "pending.reasons.security_finding", displayName: "PDF Reader", canSnooze: false, canConfirm: false, recommended: false,
    versionId: "v1", findingId: "finding-7", checkKind: "basic", risk: "high", path: undefined, dueDate: null,
    sourceRoots: [], href: "/library/pdf-reader/security?version=v1&kind=basic&finding=finding-7",
  }]);
});

it("requires the finding workflow instead of silently acknowledging risk", async () => {
  await expect(nativePendingFacade.resolve({ id: "finding", subject: "skill", kind: "security_finding", code: "finding", message: "finding" })).rejects.toThrow();
  expect(executeCommand).not.toHaveBeenCalled();
});

/**
 * 「需要恢复」的待办也必须走 `resolve_recovery`：`acknowledge_recovery` 在应用层
 * 没有实现分支，用它换来的只是 `internal.error`，这些待办项永远处置不掉。
 */
it("resolves a recovery pending item by rolling the operation back", async () => {
  vi.mocked(executeCommand).mockResolvedValue({ type: "operation_summary", payload: {} as never });
  await nativePendingFacade.resolve({
    id: "recovery:op-9:needs_recovery", subject: "op-9", kind: "recovery", code: "needs_recovery", message: "recovery",
  });
  expect(executeCommand).toHaveBeenCalledWith({
    type: "resolve_recovery",
    payload: { operation_id: "op-9", action: "rollback_operation" },
  });
});

it("recovers a recovery pending item through the same rollback path", async () => {
  vi.mocked(executeCommand).mockResolvedValue({ type: "operation_summary", payload: {} as never });
  await nativePendingFacade.recover({
    id: "recovery:op-9:needs_recovery", subject: "op-9", kind: "recovery", code: "needs_recovery", message: "recovery",
  });
  expect(executeCommand).toHaveBeenCalledWith({
    type: "resolve_recovery",
    payload: { operation_id: "op-9", action: "rollback_operation" },
  });
});

it("defers each item through an exact_pending ignore rule with a local due date", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 8, 7, 12, 0, 0));
    vi.mocked(executeCommand).mockResolvedValue({ type: "ignore_rule", payload: {} as never });
    await nativePendingFacade.defer(
      [{ id: "trial_due:skill-a:trial", subject: "skill-a", kind: "trial_due", code: "trial", message: "trial" }],
      7,
      "暂缓 7 天后再提醒",
    );
    expect(executeCommand).toHaveBeenCalledWith({
      type: "create_ignore_rule",
      payload: {
        subject: { type: "exact_pending", value: "trial_due:skill-a:trial" },
        reason: "暂缓 7 天后再提醒",
        defer_until: "2026-09-14",
      },
    });
  } finally {
    vi.useRealTimers();
  }
});

it("skips optional suggestions through the backend's eligibility check", async () => {
  vi.mocked(executeCommand).mockResolvedValue({ type: "ignore_rule", payload: {} as never });
  await nativePendingFacade.ignore([{ id: "work:ai_setup:settings:first", subject: "settings", kind: "ai_setup", code: "ai_setup", message: "setup", recommended: true }], "skip");
  expect(executeCommand).toHaveBeenCalledWith({ type: "dismiss_pending_work", payload: { item_id: "work:ai_setup:settings:first", reason: "skip", defer_until: null } });
});

it("lists handled entries only for exact_pending ignore rules", async () => {
  query.mockImplementation(async (request) => request.type === "list_pending_confirmations" ? { type: "pending_confirmations", payload: [] } : ({
    type: "ignore_rules",
    payload: [
      { id: "rule-1", subject: { type: "exact_pending", value: "trial_due:skill-a:trial" }, reason: "稍后处理", created_at: "2026-09-01T10:00:00+08:00", defer_until: "2026-09-08" },
      { id: "rule-2", subject: { type: "exact_path", value: "C:/drafts" }, reason: "路径忽略", created_at: "2026-09-01T10:00:00+08:00", defer_until: null },
    ],
  } as never));
  await expect(nativePendingFacade.listHandled()).resolves.toEqual([
    { id: "rule-1", pendingId: "trial_due:skill-a:trial", displayName: null, reason: "稍后处理", createdAt: "2026-09-01T10:00:00+08:00", deferUntil: "2026-09-08" },
  ]);
});

it("removes an ignore rule by id when undoing a handled entry", async () => {
  vi.mocked(executeCommand).mockResolvedValue({ type: "operation_summary", payload: {} as never });
  await nativePendingFacade.unignore("rule-1");
  expect(executeCommand).toHaveBeenCalledWith({ type: "remove_ignore_rule", payload: { rule_id: "rule-1" } });
});

it("restores a saved view kind and stores new kinds as JSON", async () => {  query.mockResolvedValue({
    type: "ui_preference",
    payload: { key: "pending.view.kind", value_json: "{\"kind\":\"security_finding\"}" },
  });
  await expect(nativePendingFacade.loadSavedView()).resolves.toBe("security_finding");

  vi.mocked(executeCommand).mockResolvedValue({ type: "operation_summary", payload: {} as never });
  await nativePendingFacade.saveSavedView("all");
  expect(executeCommand).toHaveBeenCalledWith({
    type: "set_ui_preference",
    payload: { key: "pending.view.kind", value_json: "{\"kind\":\"all\"}" },
  });
});

it("returns null when the saved view preference is missing or unparsable", async () => {
  query.mockResolvedValue({ type: "ui_preference", payload: { key: "pending.view.kind", value_json: null } });
  await expect(nativePendingFacade.loadSavedView()).resolves.toBeNull();

  query.mockResolvedValue({ type: "ui_preference", payload: { key: "pending.view.kind", value_json: "{not json" } });
  await expect(nativePendingFacade.loadSavedView()).resolves.toBeNull();

  query.mockResolvedValue({ type: "ui_preference", payload: { key: "pending.view.kind", value_json: "{\"kind\":\"bogus\"}" } });
  await expect(nativePendingFacade.loadSavedView()).resolves.toBeNull();
});
