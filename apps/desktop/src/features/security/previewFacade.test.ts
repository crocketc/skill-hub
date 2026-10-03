import { expect, it } from "vitest";
import { createPreviewSecurityFacade } from "./previewFacade";

it("updates in-memory preview security facts after checks and finding disposition", async () => {
  const facade = createPreviewSecurityFacade(() => new Date("2026-10-03T12:00:00.000Z"));
  const initialChecks = await facade.getChecks("skill-pdf", "v1");
  expect(initialChecks.find((check) => check.kind === "basic")?.checkedAt).toBe("2026-08-27T08:00:00Z");

  await facade.runBasicCheck?.("skill-pdf", "v1");
  const checksAfterRun = await facade.getChecks("skill-pdf", "v1");
  expect(checksAfterRun.find((check) => check.kind === "basic")).toMatchObject({
    state: "passed",
    checkedAt: "2026-10-03T12:00:00.000Z",
  });

  const [finding] = await facade.listFindings("skill-pdf", "v1");
  await facade.setFindingDisposition(finding, "acknowledged", "skill-pdf", "v1", true);
  expect((await facade.listFindings("skill-pdf", "v1"))[0].disposition).toBe("acknowledged");
});
