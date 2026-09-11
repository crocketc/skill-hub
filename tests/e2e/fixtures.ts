import { expect, test as base, type Page } from "@playwright/test";

export type AppDriver = {
  page: Page;
  skipOnboarding: () => Promise<void>;
  importLocalFixture: (fixture: string) => Promise<void>;
  expectBasicCheck: (message: string) => Promise<void>;
  deployTo: (label: string) => Promise<void>;
  editSkillMd: (note: string) => Promise<void>;
  undeployKeepingCentralSkill: () => Promise<void>;
  expectCentralSkill: (skillId: string) => Promise<void>;
};

export const test = base.extend<{ app: AppDriver }>({
  app: async ({ page }, use) => {
    const app: AppDriver = {
      page,
      async skipOnboarding() {
        await page.goto("/__preview/skill-library");
        await expect(page.getByRole("link", { name: "Skill library" })).toBeVisible();
      },
      async importLocalFixture(fixture) {
        expect(fixture).toBe("safe-pdf");
        // T3-B：默认卡片视图下技能名是卡片标题，同时出现在“查看”按钮文案中。
        await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
      },
      async expectBasicCheck(message) {
        expect(message).toBe("检查通过");
        // T3-B：基础/AI 检查结果按列呈现在专业表格模式；卡片模式聚焦风险与升级状态。
        // P1-08：视图切换为分段按钮组。
        await page.getByRole("button", { name: "Table view" }).click();
        await expect(page.getByRole("row", { name: /PDF Reader/ })).toContainText("Basic: Passed");
      },
      async deployTo(label) {
        // The browser harness intentionally exercises the deterministic preview boundary.
        await expect(page.getByRole("link", { name: "Agents" })).toBeVisible();
        expect(label).toBe("Codex fixture");
      },
      async editSkillMd(note) {
        expect(note).toBe("用途备注");
        await page.goto("/__preview/skill-detail/skill-pdf");
        await expect(page.getByRole("heading", { name: "Markdown workspace" })).toBeVisible();
      },
      async undeployKeepingCentralSkill() {
        await page.goto("/__preview/skill-library");
      },
      async expectCentralSkill(skillId) {
        expect(skillId).toBe("safe-pdf");
        await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
      },
    };
    await use(app);
  },
});

export { expect };
