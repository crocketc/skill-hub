import { expect, test } from "./fixtures";

/**
 * T0 共享基础层展板：9 主题、基础控件、状态徽标与图标注册表。
 * 只断言公开 DOM、可访问名称、几何与计算样式；截图产物走 --output 指定的任务 /tmp 目录。
 */

// 9 个预设主题的注册身份（名称与顺序锁定于 src/styles/theme.ts）。
const themeNames = [
  "moss-neutral",
  "spring-signal",
  "terracotta",
  "codex-light",
  "ocean-cobalt",
  "sakura",
  "aurora",
  "roast",
  "grok-night",
] as const;

// 主强调色必须与各主题注册性格一致（theme.ts themePalettes 的第二项）。
const expectedAccents: Record<(typeof themeNames)[number], string> = {
  "moss-neutral": "#3f7259",
  "spring-signal": "#19a95b",
  terracotta: "#d7653b",
  "codex-light": "#151614",
  "ocean-cobalt": "#3d63d8",
  sakura: "#d45e88",
  aurora: "#5952d6",
  roast: "#76513b",
  "grok-night": "#f2f3ef",
};

// 画布明暗关系：grok-night 是唯一的深色主题。
const expectedColorSchemes: Record<(typeof themeNames)[number], string> = {
  ...Object.fromEntries(
    themeNames.filter((theme) => theme !== "grok-night").map((theme) => [theme, "light"]),
  ),
  "grok-night": "dark",
} as Record<(typeof themeNames)[number], string>;

const previewWidths = [320, 800, 1024, 1440] as const;

// 浏览器语言固定，保证 i18n 驱动的壳层文案可断言。
test.use({ locale: "en-US" });

test("mounts the foundations board with every base control", async ({ page }) => {
  await page.goto("/__preview/ui-foundations");

  await expect(page.getByRole("heading", { name: "UI foundations" })).toBeVisible();
  for (const theme of themeNames) {
    await expect(page.getByRole("button", { name: theme })).toBeVisible();
  }
  await expect(page.getByRole("textbox", { name: "文本输入" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "下拉选择" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "复选框与文字共享点击区" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "立即生效的开关" })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除技能" })).toBeVisible();
});

test("applies each theme with its registered accent, canvas weight, and color scheme", async ({ page }) => {
  await page.goto("/__preview/ui-foundations");

  for (const theme of themeNames) {
    await page.getByRole("button", { name: theme }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

    const computed = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        accent: root.getPropertyValue("--color-accent").trim(),
        colorScheme: root.colorScheme,
      };
    });
    expect(computed.accent, `${theme} accent`).toBe(expectedAccents[theme]);
    expect(computed.colorScheme, `${theme} color scheme`).toBe(expectedColorSchemes[theme]);
  }
});

test("keeps icon buttons at a 40px click target with visible focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/__preview/ui-foundations");

  const deleteButton = page.getByRole("button", { name: "删除技能" });
  await expect(deleteButton).toBeVisible();

  const box = (await deleteButton.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(40);
  expect(box.height).toBeGreaterThanOrEqual(40);

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
});

test.describe("foundations board stays free of horizontal overflow", () => {
  for (const width of previewWidths) {
    test(`no root horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/ui-foundations");

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflow.scrollWidth,
        `scrollWidth (${overflow.scrollWidth}) must not exceed clientWidth (${overflow.clientWidth}) at ${width}px`,
      ).toBeLessThanOrEqual(overflow.clientWidth);
    });
  }
});

test("exposes the skip link and a single main landmark in the preview shell", async ({ page }) => {
  await page.goto("/__preview/ui-foundations");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

  const workspaceContainer = await page.evaluate(() => {
    const workspace = document.querySelector(".sh-app-shell__workspace");
    return workspace ? getComputedStyle(workspace).containerType : null;
  });
  expect(workspaceContainer).toBe("inline-size");
});
