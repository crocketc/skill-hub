import { expect, test, type Page } from "@playwright/test";

/**
 * OPT-20260914-03 / D2-2c：技能库表格末列（安全检查列）被纵向滚动条遮挡。
 *
 * 取证结论（Playwright + Chromium 1280×800 全列真实几何，2026-09-15）：
 * `.sh-skill-table__region` 上的 `scrollbar-gutter: stable` 在 Chromium 中使
 * 横向可滚范围恰好少一个槽宽——scrollLeft 钳制上限实测为
 * `scrollWidth − borderBox 宽`（CSSOM 标准应为 `scrollWidth − clientWidth`），
 * 导致横向溢出内容的末 (borderBox − clientWidth) px 永久停在纵向滚动条槽位
 * 之下、无法滚出。默认列集下 security_results 就是最后一个可见列，溢出量小于一个
 * 槽宽时 scrollLeft 被钳到 0，徽标右缘被永久盖住——即 Windows 真机
 * “滚动到最右/最下时安全检查徽标与文字不完整可读”的根因。
 *
 * 取证方式与平台边界（如实表述）：本机（macOS）与 Linux CI 的 Chromium 对
 * 滚动条一律 overlay 渲染（`--disable/--enable-features=OverlayScrollbar` 与
 * `::-webkit-scrollbar` 注入均不产生占位滚动条），因此：
 * - 「非覆盖式」模式用显式占位构造取证：给滚动容器注入
 *   `padding-inline-end: 17px` 等效复现经典滚动条对客户区的收缩，再断言同一
 *   组 CSSOM 几何不变量（可达性钳制、内容不进槽位）。该不变量在 Windows
 *   经典滚动条下同样成立（真实滚动条位于客户区之外、钳制公式相同）。
 * - 「覆盖式」模式用默认渲染直接测量。
 * 自动化证据不等于 Windows/macOS 真机验收，真机复验仍需按人工验收清单执行。
 */

const LIBRARY_ROUTE = "/__preview/skill-library?total=80";
/** Windows Chromium 经典纵向滚动条宽度（CSS px）。 */
const CLASSIC_SCROLLBAR_WIDTH = 17;

/** 隐藏列 chips（默认列集之外的 6 列），逐一点开实现“全列开启”。 */
const HIDDEN_COLUMN_LABELS = [
  "Version",
  "Source",
  "Ownership",
  "License",
  "Requirements",
  "Lifecycle",
];

interface RegionGeometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  scrollLeft: number;
  scrollTop: number;
  /** 纵向滚动条槽位占用（非覆盖式滚动条或预留槽；overlay 渲染时为 0）。 */
  verticalOccupancy: number;
  /** 横向滚动条槽位占用。 */
  horizontalOccupancy: number;
}

interface ScrollbarClearance {
  geometry: RegionGeometry;
  /** 表格右缘（滚到最右后）。 */
  tableRight: number;
  /** 各单元格内容（后代元素）的最大右缘，按 data-column 归组取最大。 */
  contentRightByColumn: Record<string, number>;
  /** 安全检查列每个徽标/计数的矩形。 */
  securityBadgeRects: Array<{ text: string; left: number; right: number; top: number; bottom: number }>;
  /** 末个表头的 data-column。 */
  lastColumn: string;
}

async function openTableWithRows(page: Page): Promise<void> {
  await page.goto(LIBRARY_ROUTE);
  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.getByRole("row", { name: /PDF Reader/ })).toBeVisible();
}

async function enableAllColumns(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Columns and density" }).click();
  const toggles = page.locator(".sh-skill-table__reorder-item");
  const toggleCount = await toggles.count();
  for (let index = 0; index < toggleCount; index += 1) {
    const item = toggles.nth(index);
    if ((await item.getAttribute("aria-pressed")) === "false") {
      await item.click();
    }
  }
  await page.getByRole("button", { name: "Columns and density" }).click();
}

/** 用键盘把 security_results 列挪到末位（复用 D2-2a 的键盘排序语义，不触碰可见性）。 */
async function moveSecurityColumnLast(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Columns and density" }).click();
  const chip = page
    .getByRole("list", { name: "Reorder columns" })
    .getByRole("button", { name: "Security results", exact: true });
  await chip.focus();
  // 默认列序中 security_results 位于索引 8/14（0 基），连按 5 次到末位。
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press("ArrowRight");
  }
  await expect(chip).toHaveAttribute("aria-roledescription", "draggable column");
  await page.getByRole("button", { name: "Columns and density" }).click();
  await expect(page.locator(".sh-skill-table thead th").last()).toHaveAttribute(
    "data-column",
    "security_results",
  );
}

async function scrollRegionToFarCorner(page: Page): Promise<ScrollbarClearance> {
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>(".sh-skill-table__region");
    const table = document.querySelector<HTMLElement>(".sh-skill-table");
    if (!region || !table) throw new Error("Expected the skill table region");
    region.scrollLeft = region.scrollWidth;
    region.scrollTop = region.scrollHeight;
    const rect = region.getBoundingClientRect();
    const style = getComputedStyle(region);
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderRight = parseFloat(style.borderRightWidth) || 0;
    const borderBottom = parseFloat(style.borderBottomWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const geometry: RegionGeometry = {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      clientWidth: region.clientWidth,
      clientHeight: region.clientHeight,
      scrollWidth: region.scrollWidth,
      scrollHeight: region.scrollHeight,
      scrollLeft: region.scrollLeft,
      scrollTop: region.scrollTop,
      verticalOccupancy: rect.width - borderLeft - borderRight - region.clientWidth,
      horizontalOccupancy: rect.height - borderTop - borderBottom - region.clientHeight,
    };
    const contentRightByColumn: Record<string, number> = {};
    for (const cell of region.querySelectorAll<HTMLElement>("tbody td")) {
      let contentRight = cell.getBoundingClientRect().left;
      for (const descendant of cell.querySelectorAll("*")) {
        contentRight = Math.max(contentRight, descendant.getBoundingClientRect().right);
      }
      contentRightByColumn[cell.dataset.column ?? ""] = Math.max(
        contentRightByColumn[cell.dataset.column ?? ""] ?? 0,
        contentRight,
      );
    }
    const securityBadgeRects = [
      ...region.querySelectorAll<HTMLElement>(
        "td[data-column='security_results'] .sh-skill-table__security-results > *",
      ),
    ].map((badge) => {
      const badgeRect = badge.getBoundingClientRect();
      return {
        text: (badge.textContent ?? "").trim(),
        left: badgeRect.left,
        right: badgeRect.right,
        top: badgeRect.top,
        bottom: badgeRect.bottom,
      };
    });
    const headers = region.querySelectorAll<HTMLElement>(".sh-skill-table thead th[data-column]");
    const last = headers[headers.length - 1];
    return {
      geometry,
      tableRight: table.getBoundingClientRect().right,
      contentRightByColumn,
      securityBadgeRects,
      lastColumn: last?.dataset.column ?? "",
    };
  });
}

test("all enabled columns scroll fully clear of the vertical scrollbar slot", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openTableWithRows(page);
  await enableAllColumns(page);
  await expect(page.locator("th[data-column='requirements']")).toBeAttached();

  // 前提：行数足以触发纵向滚动（用户场景 = 同时存在纵横两个方向的溢出）。
  await scrollRegionToFarCorner(page);
  const verticalScroll = await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>(".sh-skill-table__region");
    if (!region) throw new Error("Expected the skill table region");
    return region.scrollTop;
  });
  expect(verticalScroll).toBeGreaterThan(0);

  await moveSecurityColumnLast(page);
  const { geometry, tableRight, contentRightByColumn, securityBadgeRects, lastColumn } =
    await scrollRegionToFarCorner(page);
  expect(lastColumn).toBe("security_results");

  // 核心不变量（CSSOM 标准钳制）：横向滚距必须达到 scrollWidth − clientWidth。
  // 取证基线（gutter stable）：scrollLeft 钳制在 783 < 798−1，末 15px 永久不可达。
  expect(geometry.scrollLeft).toBeGreaterThanOrEqual(
    geometry.scrollWidth - geometry.clientWidth - 1,
  );

  // 纵向滚动条槽位矩形：非覆盖式滚动条（或预留槽）占据区域右缘；overlay 为零宽。
  const slotLeft = geometry.right - geometry.verticalOccupancy;
  // 表格与所有单元格内容不得与槽位相交；overlay 模式下内容不得超出客户区右缘。
  expect(tableRight).toBeLessThanOrEqual(slotLeft + 1);
  for (const [column, contentRight] of Object.entries(contentRightByColumn)) {
    expect(contentRight, `column ${column} content clears the scrollbar slot`).toBeLessThanOrEqual(
      slotLeft + 1,
    );
  }

  // 安全检查徽标（图标 + 短文本 + 换行堆叠）逐个不进槽位，且完整落在
  // 横向滚动条上缘之上（滚到最下后不被底部滚动条压住）。
  expect(securityBadgeRects.length).toBeGreaterThan(0);
  const slotBottom = geometry.bottom - geometry.horizontalOccupancy;
  for (const badge of securityBadgeRects) {
    expect(badge.right, `badge "${badge.text}" clears the scrollbar slot`).toBeLessThanOrEqual(
      slotLeft + 1,
    );
    expect(badge.bottom, `badge "${badge.text}" stays above the horizontal scrollbar`).toBeLessThanOrEqual(
      slotBottom + 1,
    );
  }
});

test("default column set keeps the trailing security results column readable at 1280", async ({ page }) => {
  // 用户真机场景：默认列集下 security_results 就是最后一个可见列；1280 视口 +
  // 纵向滚动条出现后，其徽标右缘必须留在客户区内（不允许“滚不回来的遮挡”）。
  await page.setViewportSize({ width: 1280, height: 800 });
  await openTableWithRows(page);

  const { geometry, contentRightByColumn, securityBadgeRects } = await scrollRegionToFarCorner(page);
  const clientRight = geometry.left + geometry.clientWidth;
  const slotLeft = geometry.right - geometry.verticalOccupancy;

  // 纵向滚动存在（前提）。
  expect(geometry.scrollTop).toBeGreaterThan(0);

  const securityContentRight = contentRightByColumn.security_results;
  expect(securityContentRight).toBeDefined();
  // 滚到最右最下后，安全检查列内容必须完整可读：不进纵向滚动条槽位。
  expect(securityContentRight, "security content clears the scrollbar slot").toBeLessThanOrEqual(
    slotLeft + 1,
  );
  for (const badge of securityBadgeRects) {
    expect(badge.right, `badge "${badge.text}" clears the scrollbar slot`).toBeLessThanOrEqual(
      slotLeft + 1,
    );
  }
  // 客户区右缘冗余锁定（overlay 模式下 slotLeft === region 右缘）。
  expect(securityContentRight).toBeLessThanOrEqual(clientRight + 1);
});

test("simulated classic scrollbar keeps every column reachable and clear of the slot", async ({ page }) => {
  // 非覆盖式滚动条取证：本机 Chromium 滚动条一律 overlay 渲染（padding-inline-end
  // 位于 clientWidth 之内、无法模拟客户区收缩，已在红测试中实测否定），改用
  // `border-inline-end: 17px` 显式占位——边框位于客户区之外、区域盒之内，正是
  // Windows 经典纵向滚动条的绘制位置；随后断言同一组几何不变量（钳制公式与
  // 槽位间距在真机上由同一 CSSOM 规则保证）。
  await page.setViewportSize({ width: 1280, height: 800 });
  await openTableWithRows(page);
  await enableAllColumns(page);
  await page.addStyleTag({
    content: `.sh-skill-library .sh-skill-table__region { border-inline-end: ${CLASSIC_SCROLLBAR_WIDTH}px solid transparent; }`,
  });

  const { geometry, tableRight, securityBadgeRects } = await scrollRegionToFarCorner(page);

  // 前提：注入后客户区至少收缩了一个经典滚动条宽度（占位构造生效）。
  const borderBoxWidth = geometry.right - geometry.left;
  expect(borderBoxWidth - geometry.clientWidth).toBeGreaterThanOrEqual(CLASSIC_SCROLLBAR_WIDTH);

  // 标准钳制不变量：真实占位下必须能滚满 scrollWidth − clientWidth。
  // 取证基线（gutter stable）：钳制在 scrollWidth − borderBox 宽（783 < 814）。
  expect(geometry.scrollLeft).toBeGreaterThanOrEqual(
    geometry.scrollWidth - geometry.clientWidth - 1,
  );

  // 内容与表格不进入模拟滚动条槽位（区域右缘 17px 边框条带）。
  const slotLeft = geometry.right - CLASSIC_SCROLLBAR_WIDTH;
  expect(tableRight).toBeLessThanOrEqual(slotLeft + 1);
  for (const badge of securityBadgeRects) {
    expect(badge.right, `badge "${badge.text}" clears the simulated slot`).toBeLessThanOrEqual(
      slotLeft + 1,
    );
  }
});
