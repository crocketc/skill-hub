import { expect, test, type Locator } from "./fixtures";
import { expectUnifiedPageRhythm } from "./page-rhythm";

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

// 任务 9 冻结五指标（api.ts getOverviewSummaryMetrics 口径，api.test.ts 锁定）：
// hero = 技能总数；紧凑带 = 合并 Agent、管理项目、部署关系（按 Agent/项目拆分）、
// 待确认冲突。预览桩（OverviewPreview overviewPreviewRelationshipsFacade）提供
// 确定性关系事实：2 个待确认冲突、4 个图谱候选、9 条治理关系边。
const heroMetricName = "27 Total skills";
const statNames = [
  "3 Agents (3 configured · 5 discovered)",
  "3 Manage projects",
  "45 Skill deployment relations (27 to agents · 18 to projects)",
  "2 Unconfirmed relationship conflicts",
] as const;

const relationEntryNames = [
  "Open relationship graph (4 skills with displayable relations)",
  "Open conflict workspace (2 unconfirmed conflicts)",
  "Open relationship governance (9 relation edges)",
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

  // T3-C「每路由唯一 h1」回归（任务 10 h1 sweep）：顶栏标题降级为非 heading
  // 后，route-level h1 由页面自持。此处把任务 5 临时锁定的 `h1 count 0`
  // 断言翻回 `h1 count === 1`（Task 5 review 请求的 flip-back 注记），
  // 顶栏标题保持可见但不再进入 heading outline。
  await expect(page.locator(".sh-app-shell__title")).toHaveText("Overview");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("link", { name: heroMetricName })).toBeVisible();
  const stats = page.getByRole("list", { name: "Key stats" });
  for (const name of statNames) {
    await expect(stats.getByRole("link", { name })).toBeVisible();
  }
  await expect(page.getByRole("img", { name: "Deployment relation count by agent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "4 pending items" })).toBeVisible();
});

test("exposes the three relationship thumbnail entries with frozen deep links", async ({
  page,
}) => {
  await page.goto("/__preview/overview");

  // 任务 9 冻结契约：缩略带三入口深链 /relationships、/relationships/decisions、
  // /relationships/governance；计数来自预览桩的确定性关系事实。
  const graphEntry = page.getByRole("link", { name: relationEntryNames[0] });
  await expect(graphEntry).toBeVisible();
  await expect(graphEntry).toHaveAttribute("href", "/relationships");
  const conflictsEntry = page.getByRole("link", { name: relationEntryNames[1] });
  await expect(conflictsEntry).toHaveAttribute("href", "/relationships/decisions");
  const governanceEntry = page.getByRole("link", { name: relationEntryNames[2] });
  await expect(governanceEntry).toHaveAttribute("href", "/relationships/governance");

  // 深链真实可达：点击冲突入口导航到冲突处理页。
  await conflictsEntry.click();
  await expect(page).toHaveURL(/\/relationships\/decisions$/);
});

test("drills the conflict metric into the decisions workbench (P1-07 flip)", async ({
  page,
}) => {
  await page.goto("/__preview/overview");

  // P1-07 裁决（冻结指标契约后果）：发现到的 Agent 不再单独成卡，也不再有
  // 概览→发现工作台的直链；发现保持经侧栏与图谱零候选 CTA 一等入口。
  // 合并后的 Agent 指标钻取 /agents；冲突指标钻取冲突处理页。
  await page.getByRole("link", { name: statNames[0] }).click();
  await expect(page).toHaveURL(/\/agents$/);

  await page.goBack();
  await page.getByRole("link", { name: "2 Unconfirmed relationship conflicts" }).click();
  await expect(page).toHaveURL(/\/relationships\/decisions$/);
});

test.describe("overview stays free of horizontal overflow", () => {
  for (const width of previewWidths) {
    test(`no root horizontal overflow at ${width}x900`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/overview");

      await expect(page.getByRole("link", { name: heroMetricName })).toBeVisible();
      await expectNoRootHorizontalOverflow(page);
    });
  }

  // P2-01：页头↔正文的留白节奏统一消费 --page-gap（= --space-4 = 16px），
  // 且 PageFrame 不再叠加第二层内边距（AppShell 内容区已统一提供留白）。
  for (const width of previewWidths) {
    test(`keeps the unified page rhythm at ${width}x900`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/__preview/overview");

      await expect(page.getByRole("link", { name: heroMetricName })).toBeVisible();
      await expectUnifiedPageRhythm(page, ".sh-overview", "overview");
    });
  }

  test("no root horizontal overflow at 800x600 minimum height", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto("/__preview/overview");

    await expect(page.getByRole("link", { name: heroMetricName })).toBeVisible();
    await expectNoRootHorizontalOverflow(page);
    await expect(page.getByRole("heading", { name: "4 pending items" })).toBeVisible();
  });

  test("keeps the compact overview panels non-overlapping at 800x600", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto("/__preview/overview");

    await expect(page.getByRole("link", { name: relationEntryNames[2] })).toBeVisible();
    const panels = await page.locator(
      ".sh-overview__metrics, .sh-overview__content-grid, .sh-overview__relations",
    ).evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, height: rect.height, top: rect.top };
    }));

    expect(panels).toHaveLength(3);
    for (let index = 1; index < panels.length; index += 1) {
      expect(
        panels[index]!.top,
        `overview panel ${index} must start after the previous panel ends`,
      ).toBeGreaterThanOrEqual(panels[index - 1]!.bottom - 1);
      expect(panels[index]!.height, `overview panel ${index} must remain measurable`).toBeGreaterThan(0);
    }

    const tagDetails = page.locator(".sh-overview__tag-details-scroll");
    await expect(tagDetails).toHaveCSS("overflow-y", "auto");
    await expectNoRootHorizontalOverflow(page);
  });
});

test("stacks chart and pending into one column with single-column stats at 800px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/__preview/overview");

  // 冲突指标在关系投影落地后才成为可钻取链接（预览桩确定性）。几何测量
  // 前先等它就位，避免占位状态引入的测量竞态。
  await expect(page.getByRole("link", { name: statNames[3] })).toBeVisible();

  // 窄容器：图表面板与待处理区域纵向堆叠，不再并排。
  const chartBox = await boxOf(page.getByRole("img", { name: "Deployment relation count by agent" }));
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
    name: "View Aurora Mobile Workspace's 9 deployment relations",
  });
  await expect(longLabel).toBeVisible();
  await expectNoRootHorizontalOverflow(page);
});

test("keeps two stat columns and a single-column chart area at 1024px", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/__preview/overview");

  // 见 800px 用例：等冲突指标就位后再测量。
  await expect(page.getByRole("link", { name: statNames[3] })).toBeVisible();

  const boxes = [];
  for (const link of await statLinks(page)) {
    boxes.push(await boxOf(link));
  }
  expect(distinctRowCount(boxes), "compact stats must form a 2x2 grid").toBe(2);

  const chartBox = await boxOf(page.getByRole("img", { name: "Deployment relation count by agent" }));
  const pendingBox = await boxOf(page.getByRole("heading", { name: "4 pending items" }));
  expect(
    chartBox.y + chartBox.height,
    "the chart and pending areas must stack at 1024px",
  ).toBeLessThanOrEqual(pendingBox.y + 1);
  await expectNoRootHorizontalOverflow(page);
});

test("keeps the two-row metrics contract with four stat columns at 1440px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__preview/overview");

  // 见 800px 用例：等冲突指标就位后再测量。
  await expect(page.getByRole("link", { name: statNames[3] })).toBeVisible();

  const boxes = [];
  for (const link of await statLinks(page)) {
    boxes.push(await boxOf(link));
  }
  expect(distinctRowCount(boxes), "compact stats must sit in a single 4-column row").toBe(1);

  // M-20 两行指标契约：宽屏只缩放不换结构——hero 独占第一行，四张紧凑统计
  // 卡在第二行；禁止恢复 hero+统计并入单行的 5 卡横带。
  // 契约同步（2026-09-14）：2026-09-13 验收把 hero min-height 从 7rem 调整为
  // 5rem（overview.css .sh-overview__hero，自然排版下限）；原“6rem=96px 密度
  // 档”断言随该验收过时，这里锁定现行 5rem=80px 下限，两行结构断言不变。
  const heroBox = await boxOf(page.getByRole("link", { name: heroMetricName }));
  expect(heroBox.height, "the hero metric must keep the 5rem density floor").toBeGreaterThanOrEqual(
    80,
  );
  for (const box of boxes) {
    expect(box.height, "compact stats must reach the 4rem density rung").toBeGreaterThanOrEqual(64);
  }
  expect(
    heroBox.y + heroBox.height,
    "the hero row must sit above the compact stats row",
  ).toBeLessThanOrEqual(Math.min(...boxes.map((box) => box.y)) + 1);

  const chartBox = await boxOf(page.getByRole("img", { name: "Deployment relation count by agent" }));
  const pendingBox = await boxOf(page.getByRole("heading", { name: "4 pending items" }));
  expect(
    pendingBox.y,
    "the pending rail must stay beside the chart panel on wide containers",
  ).toBeLessThan(chartBox.y + chartBox.height);
  await expectNoRootHorizontalOverflow(page);
});

test("drills pending summary items into the pending workbench", async ({ page }) => {
  await page.goto("/__preview/overview");

  await page.getByRole("link", { name: "2 security findings" }).click();

  await expect(page).toHaveURL(/\/pending$/);
});

test("reaches every overview control by keyboard with visible focus", async ({ page }) => {
  await page.goto("/__preview/overview");

  // 键盘遍历跨越指标带与缩略带：先等关系投影落地（冲突指标与三个入口
  // 就位），占位符不可聚焦，否则遍历会在半途失配。
  await expect(page.getByRole("link", { name: relationEntryNames[2] })).toBeVisible();

  await page.getByRole("link", { name: heroMetricName }).focus();
  await page.keyboard.press("Tab");
  // 任务 9 冻结指标顺序：hero → 合并 Agent → 管理项目 → 部署关系 → 待确认冲突。
  await expect(page.getByRole("link", { name: statNames[0] })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: statNames[1] })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: statNames[2] })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: statNames[3] })).toBeFocused();
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

  // 切到项目维度后，Tab 依次到达：图表钻取按钮（M-20 起可聚焦）→ 标签环图
  // chart-link → 待办摘要的三条待办链接。契约迁移说明（2026-09-14）：M-20
  // 标签环图（4569d75，2026-09-13）引入的 chart-link 按钮位于 DOM 中
  // PendingSummary 之前，键盘顺序随之更新——这是规格侧过时的契约同步，
  // 不是放松断言；「待办链接可键盘可达」的实质断言保留。
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "View Aurora Mobile Workspace's 9 deployment relations" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "View Orbital Docs's 6 deployment relations" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "View SkillHub Website's 3 deployment relations" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "View 8 skills tagged writing" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "View 6 skills tagged pdf" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "View 4 skills tagged data-analysis" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "2 security findings" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "1 recovery action" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "1 trial due" })).toBeFocused();
  // 任务 9 冻结契约（任务 10 接线）：待办摘要之后是三个关系缩略入口深链。
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: relationEntryNames[0] })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: relationEntryNames[1] })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: relationEntryNames[2] })).toBeFocused();
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
      await expect(page.getByRole("img", { name: "Deployment relation count by agent" })).toBeVisible();
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
      await expect(page.getByRole("link", { name: heroMetricName })).toBeVisible();
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

  await expect(page.getByRole("img", { name: "Deployment relation count by agent" })).toBeVisible();
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
