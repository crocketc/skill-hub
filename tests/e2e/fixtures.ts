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
        await expect(page.getByText("PDF Reader")).toBeVisible();
      },
      async expectBasicCheck(message) {
        expect(message).toBe("检查通过");
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
        await expect(page.getByText("PDF Reader")).toBeVisible();
      },
    };
    await use(app);
  },
});

export { expect };
