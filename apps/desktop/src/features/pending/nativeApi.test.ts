import { beforeEach, expect, it, vi } from "vitest";
import { queryApplication } from "../../api/bindings";
import { nativePendingFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({ queryApplication: vi.fn() }));

const query = vi.mocked(queryApplication);

beforeEach(() => query.mockReset());

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

it("keeps unsupported pending mutations explicit", async () => {
  await expect(nativePendingFacade.resolve({
    id: "trial_due:skill:trial",
    subject: "skill",
    kind: "trial_due",
    code: "trial",
    message: "trial",
  })).rejects.toThrow("pending_resolve is not connected yet");
});
