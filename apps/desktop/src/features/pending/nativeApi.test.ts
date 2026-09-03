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
    }],
  });

  await expect(nativePendingFacade.list()).resolves.toEqual([{
    id: "security_finding:pdf-reader:finding-7",
    subject: "pdf-reader",
    kind: "security_finding",
    code: "finding-7",
    message: "pending.securityFinding",
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
