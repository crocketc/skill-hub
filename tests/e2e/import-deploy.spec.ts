import { test } from "./fixtures";

test("ordinary user lifecycle remains inspectable without Git or admin", async ({ app }) => {
  await app.skipOnboarding();
  await app.importLocalFixture("safe-pdf");
  await app.expectBasicCheck("检查通过");
  await app.deployTo("Codex fixture");
  await app.editSkillMd("用途备注");
  await app.undeployKeepingCentralSkill();
  await app.expectCentralSkill("safe-pdf");
});
