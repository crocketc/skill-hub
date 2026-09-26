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
  query.mockImplementation(async (request) => {
    if (request.type === "get_conflict_workspace") return { type: "conflict_workspace", payload: { cases: [] } } as never;
    if (request.type === "list_relation_governance") return { type: "relation_governance_ledger", payload: { rows: [] } } as never;
    if (request.type === "list_recovery_candidates") return { type: "recovery_candidates", payload: [] };
    if (request.type === "get_skill") return { type: "skill", payload: { display_name: "PDF Reader" } } as never;
    return {
    type: "pending_items",
    payload: [{
      subject: "pdf-reader",
      kind: "security_finding",
      code: "finding-7",
      message_code: "pending.securityFinding",
      risk: "high",
      affected_deployments: 2,
    }],
    };
  });

  await expect(nativePendingFacade.list()).resolves.toEqual([{
    id: "security_finding:pdf-reader:finding-7",
    subject: "pdf-reader",
    kind: "security_finding",
    code: "finding-7",
    message: "pending.reasons.security_finding",
    dueDate: null,
    risk: "high",
    affectedDeployments: 2,
    displayName: "PDF Reader",
    href: "/library/pdf-reader/security",
  }]);
});

it("resolves a security finding through the matching typed command", async () => {
  query.mockResolvedValueOnce({ type: "skill", payload: { current_version: "version-1" } as never });
  vi.mocked(executeCommand).mockResolvedValue({ type: "basic_check_result", payload: {} as never });
  await nativePendingFacade.resolve({
    id: "security_finding:skill:finding-7", subject: "skill", kind: "security_finding", code: "finding-7", message: "finding",
  });
  expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({
    type: "set_finding_disposition",
    payload: expect.objectContaining({ skill_id: "skill", version_id: "version-1", finding_id: "finding-7", disposition: "acknowledged" }),
  }));
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

it("ignores items permanently by deferring with a null due date", async () => {
  vi.mocked(executeCommand).mockResolvedValue({ type: "ignore_rule", payload: {} as never });
  await nativePendingFacade.ignore(
    [{ id: "security_finding:skill-b:finding-7", subject: "skill-b", kind: "security_finding", code: "finding-7", message: "finding" }],
    "永久忽略该待处理事项",
  );
  expect(executeCommand).toHaveBeenCalledWith({
    type: "create_ignore_rule",
    payload: {
      subject: { type: "exact_pending", value: "security_finding:skill-b:finding-7" },
      reason: "永久忽略该待处理事项",
      defer_until: null,
    },
  });
});

it("lists handled entries only for exact_pending ignore rules", async () => {
  query.mockResolvedValue({
    type: "ignore_rules",
    payload: [
      { id: "rule-1", subject: { type: "exact_pending", value: "trial_due:skill-a:trial" }, reason: "稍后处理", created_at: "2026-09-01T10:00:00+08:00", defer_until: "2026-09-08" },
      { id: "rule-2", subject: { type: "exact_path", value: "C:/drafts" }, reason: "路径忽略", created_at: "2026-09-01T10:00:00+08:00", defer_until: null },
    ],
  } as never);
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
