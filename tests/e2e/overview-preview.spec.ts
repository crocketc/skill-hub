import { expect, test, type Locator } from "./fixtures";

/**
 * T3-A 概览预览（/__preview/overview）：确定性夹具上的信息层级、响应式、
 * 主题与键盘契约。只断言公开 DOM、可访问名称、几何与计算样式；
 * Playwright 产物写入 --output 指定的任务专用 /tmp 目录。
 */

const previewWidths = [800, 1024, 1280, 1440] as const;

// 9 个预设主题的注册身份与强调色（锁定于 src/styles/theme.ts）。
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

const statNames = [
  "3 configured agents",
  "5 discovered agents",
  "3 projects",
  "27 deployments",
] as const;

test.use({ locale: "en-US" });

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, "expected the element to have a layout box").not.toBeNull();
  return box!;
}

/** 按纵坐标聚合的行数（容差 4px），用于断言统计的 1/2/4 列形态。 */
function distinctRowCount(boxes: Array<{ y: number }>, tolerance = 4): number {
  const rows: number[] = [];
  for (const box of boxes) {
    if (!rows.some((existing) => Math.abs(existing - box.y) <= tolerance)) {
      rows.push(box.y);
    }
  }
  return rows.length;
}

async function expectNoRootHorizontalOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `scrollWidth (${overflow.scrollWidth}) must not exceed clientWidth (${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

async function statLinks(page: import("@playwright/test").Page) {
  const stats = page.getByRole("list", { name: "Key stats" });
  return statNames.map((name) => stats.getByRole("link", { name }));
}

test("mounts the overview preview with one primary metric and compact stats", async ({
  page,
}) => {
  await page.goto("/__preview/overview");

  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "27 skills" })).toBeVisible();
  const stats = page.getByRole("list", { name: "Key stats" });
  for (const name of statNames) {
    await expect(stats.getByRole("link", { name })).toBeVisible();
  }
  await expect(page.getByRole("img", { name: "Deployment count by agent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "4 pending items" })).toBeVisible();
});

test.describe("overview stays free of horizontal overflow", () => {
  for (const width of previewWidths) {
    test(`no root horizontal overflow at ${width}x900`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/overview");

      await expect(page.getByRole("link", { name: "27 skills" })).toBeVisible();
      await expectNoRootHorizontalOverflow(page);
    });
  }

  test("no root horizontal overflow at 800x600 minimum height", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto("/__preview/overview");

    await expect(page.getByRole("link", { name: "27 skills" })).toBeVisible();
    await expectNoRootHorizontalOverflow(page);
    await expect(page.getByRole("heading", { name: "4 pending items" })).toBeVisible();
  });
});

test("stacks chart and pending into one column with single-column stats at 800px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/__preview/overview");

  // 窄容器：图表面板与待处理区域纵向堆叠，不再并排。
  const chartBox = await boxOf(page.getByRole("img", { name: "Deployment count by agent" }));
  const pendingBox = await boxOf(page.getByRole("heading", { name: "4 pending items" }));
  expect(
    chartBox.y + chartBox.height,
    "the pending rail must start below the chart panel at narrow container widths",
  ).toBeLessThanOrEqual(pendingBox.y + 1);

  // 紧凑统计退化为单列：四个统计项各占一行。
  const boxes = [];
  for (const link of await statLinks(page)) {
    boxes.push(await boxOf(link));
  }
  expect(distinctRowCount(boxes), "compact stats must stack into one column").toBe(4);

  // 长项目名在窄容器中保持可读且不产生根级横向溢出。
  await page.getByRole("radio", { name: "Projects" }).click();
  const longLabel = page.getByRole("button", {
    name: "View Aurora Mobile Workspace's 9 deployments",
  });
  await expect(longLabel).toBeVisible();
  await expectNoRootHorizontalOverflow(page);
});

test("keeps two stat columns and a single-column chart area at 1024px", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/__preview/overview");

  const boxes = [];
  for (const link of await statLinks(page)) {
    boxes.push(await boxOf(link));
  }
  expect(distinctRowCount(boxes), "compact stats must form a 2x2 grid").toBe(2);

  const chartBox = await boxOf(page.getByRole("img", { name: "Deployment count by agent" }));
  const pendingBox = await boxOf(page.getByRole("heading", { name: "4 pending items" }));
  expect(
    chartBox.y + chartBox.height,
    "the chart and pending areas must stack at 1024px",
  ).toBeLessThanOrEqual(pendingBox.y + 1);
  await expectNoRootHorizontalOverflow(page);
});

test("keeps four stat columns and the side-by-side workspace at 1440px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/overview");

  const boxes = [];
  for (const link of await statLinks(page)) {
    boxes.push(await boxOf(link));
  }
  expect(distinctRowCount(boxes), "compact stats must sit in a single 4-column row").toBe(1);

  // P1-07 密度阶梯：宽容器下 hero 与紧凑统计并入同一条指标带（同一行），
  // hero ≥ 6rem（96px）、紧凑卡 ≥ 4rem（64px），替代原先 2.5rem 的矮卡。
  const heroBox = await boxOf(page.getByRole("link", { name: "27 skills" }));
  expect(heroBox.height, "the hero metric must reach the 6rem density rung").toBeGreaterThanOrEqual(
    96,
  );
  for (const box of boxes) {
    expect(box.height, "compact stats must reach the 4rem density rung").toBeGreaterThanOrEqual(64);
  }
  expect(
    Math.abs(heroBox.y - boxes[0].y),
    "the hero and compact stats must share the metrics band row",
  ).toBeLessThanOrEqual(4);

  const chartBox = await boxOf(page.getByRole("img", { name: "Deployment count by agent" }));
  const pendingBox = await boxOf(page.getByRole("heading", { name: "4 pending items" }));
  expect(
    pendingBox.y,
    "the pending rail must stay beside the chart panel on wide containers",
  ).toBeLessThan(chartBox.y + chartBox.height);
  await expectNoRootHorizontalOverflow(page);
});

test("drills the discovered agents stat into the local discovery workbench", async ({ page }) => {
  await page.goto("/__preview/overview");

  // P1-07：发现到的 Agent 不再与已配置目标同去 /agents，而是进入本机发现工作台。
  await page.getByRole("link", { name: "5 discovered agents" }).click();

  await expect(page).toHaveURL(/\/discovery\/local$/);
});

test("drills pending summary items into the pending workbench", async ({ page }) => {
  await page.goto("/__preview/overview");

  await page.getByRole("link", { name: "2 security findings" }).click();

  await expect(page).toHaveURL(/\/pending$/);
});

test("reaches every overview control by keyboard with visible focus", async ({ page }) => {
  await page.goto("/__preview/overview");

  await page.getByRole("link", { name: "27 skills" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "3 configured agents" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "5 discovered agents" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "3 projects" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "27 deployments" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Agents" })).toBeFocused();

  // 聚焦的维度切换项必须把可见焦点画在可见的选项胶囊上（输入框本身透明）。
  const expectFocusedPillOutline = async () => {
    const focusPill = await page.evaluate(() => {
      const input = document.activeElement as HTMLElement | null;
      const pill = input?.nextElementSibling as HTMLElement | null;
      if (!pill) {
        return { outlineStyle: "missing-pill", outlineWidth: 0 };
      }
      const style = getComputedStyle(pill);
      return { outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
    });
    expect(
      focusPill.outlineStyle,
      "the focused dimension pill must show a visible outline",
    ).not.toBe("none");
    expect(focusPill.outlineWidth).toBeGreaterThanOrEqual(2);
  };
  await expectFocusedPillOutline();

  // 同组单选项按 roving tabindex 规则用方向键切换，Tab 直接离开整组。
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Projects" })).toBeFocused();
  await expectFocusedPillOutline();

  // 切到项目维度后，Tab 依次到达：待办摘要的三条待办链接（P1-07：待办项
  // 可钻取 /pending，成为可聚焦控件），再到达明细列表的首条项目明细。
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "2 security findings" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "1 recovery action" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "1 trial due" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "View Aurora Mobile Workspace's 9 deployments" }),
  ).toBeFocused();
});

test.describe("overview honors the theme contract at 1280x900", () => {
  for (const theme of themeNames) {
    test(`renders ${theme} with token-driven chart colors and visible focus`, async ({
      page,
    }) => {
      await page.addInitScript((preset) => {
        window.localStorage.setItem("skillhub.appearance", preset);
      }, theme);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/__preview/overview");

      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("img", { name: "Deployment count by agent" })).toBeVisible();
      await page
        .waitForFunction(() => document.querySelectorAll("main svg [fill]").length > 0)
        .catch(() => {
          throw new Error("the deployment chart never rendered its bars");
        });

      const chartColors = await page.evaluate(() => {
        const accent = getComputedStyle(document.documentElement)
          .getPropertyValue("--color-accent")
          .trim();
        const fills = Array.from(
          document.querySelectorAll("main svg [fill]"),
          (element) => element.getAttribute("fill"),
        );
        return { accent, barUsesAccent: fills.includes(accent) };
      });
      expect(chartColors.accent, `${theme} accent token`).toBe(expectedAccents[theme]);
      expect(
        chartColors.barUsesAccent,
        `${theme}: chart bars must take their color from the theme accent token`,
      ).toBe(true);

      // 关键控件与状态在该主题下可见，且不产生根级横向溢出。
      await expect(page.getByRole("link", { name: "27 skills" })).toBeVisible();
      await expect(page.getByText("4 open")).toBeVisible();
      await expectNoRootHorizontalOverflow(page);

      await page.keyboard.press("Tab");
      await expect(page.locator(":focus")).toBeVisible();
    });
  }
});

test("renders without continuous motion when the system prefers reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/__preview/overview");

  await expect(page.getByRole("img", { name: "Deployment count by agent" })).toBeVisible();
  // base.css 的全局减少动效守卫把时长钳制到 0.01ms；这里断言概览没有任何
  // 超过感知阈值的过渡或动画（图表动画本就关闭）。
  const freeOfMotion = await page.waitForFunction(() => {
    const motionBudgetSeconds = 0.05;
    for (const element of document.querySelectorAll("main *")) {
      const style = getComputedStyle(element);
      const durations = [
        ...style.transitionDuration.split(","),
        ...style.animationDuration.split(","),
      ];
      if (durations.some((duration) => parseFloat(duration) > motionBudgetSeconds)) {
        return false;
      }
    }
    return true;
  });
  expect(await freeOfMotion.jsonValue()).toBe(true);
});
