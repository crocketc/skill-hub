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

// W1-3：预览里常驻的基础检查代表导入时登记的记录（trigger=import），
// AI 检查与其余结果保持缺省；手动重跑替换为无来源标注的手动结果。
it("marks the standing basic check as the import-time record until a manual rerun", async () => {
  const facade = createPreviewSecurityFacade(() => new Date("2026-10-03T12:00:00.000Z"));

  const initialChecks = await facade.getChecks("skill-pdf", "v1");
  expect(initialChecks.find((check) => check.kind === "basic")).toMatchObject({ trigger: "import" });
  expect(initialChecks.find((check) => check.kind === "llm")?.trigger).toBeUndefined();

  await facade.runBasicCheck?.("skill-pdf", "v1");
  const checksAfterRun = await facade.getChecks("skill-pdf", "v1");
  expect(checksAfterRun.find((check) => check.kind === "basic")?.trigger).toBeUndefined();
});
