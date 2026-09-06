import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { nativePendingFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({ queryApplication: vi.fn(), executeCommand: vi.fn() }));

const query = vi.mocked(queryApplication);

  beforeEach(() => { query.mockReset(); vi.mocked(executeCommand).mockReset(); });

it("maps derived pending work to stable page identities", async () => {
  query.mockResolvedValue({
    type: "pending_items",
    payload: [{
      subject: "pdf-reader",
      kind: "security_finding",
      code: "finding-7",
      message_code: "pending.securityFinding",
      risk: "high",
      affected_deployments: 2,
    }],
  });

  await expect(nativePendingFacade.list()).resolves.toEqual([{
    id: "security_finding:pdf-reader:finding-7",
    subject: "pdf-reader",
    kind: "security_finding",
    code: "finding-7",
    message: "pending.securityFinding",
    dueDate: null,
    risk: "high",
    affectedDeployments: 2,
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
    { id: "rule-1", pendingId: "trial_due:skill-a:trial", reason: "稍后处理", createdAt: "2026-09-01T10:00:00+08:00", deferUntil: "2026-09-08" },
  ]);
});

it("removes an ignore rule by id when undoing a handled entry", async () => {
  vi.mocked(executeCommand).mockResolvedValue({ type: "operation_summary", payload: {} as never });
  await nativePendingFacade.unignore("rule-1");
  expect(executeCommand).toHaveBeenCalledWith({ type: "remove_ignore_rule", payload: { rule_id: "rule-1" } });
});

it("restores a saved view kind and stores new kinds as JSON", async () => {
  query.mockResolvedValue({
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
