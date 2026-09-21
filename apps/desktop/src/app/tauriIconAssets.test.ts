import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";

/**
 * 新增03（0.2.0 验收反馈）：SkillHub 应用图标接入 Tauri 的结构验证。
 * 公开接缝 = 读取 `src-tauri/tauri.conf.json` + 文件系统确定性校验：
 * 配置引用的每个图标文件必须存在、格式正确、尺寸正确，且与
 * `assets/branding/tauri-icons/` 的受控母本逐字节一致。
 * 这里只做结构验证；真实安装与任务栏/标题栏观感仍需真机人工验收。
 */

const desktopRoot = process.cwd();
const tauriRoot = path.join(desktopRoot, "src-tauri");
const masterSourceRoot = path.resolve(desktopRoot, "..", "..", "assets", "branding", "tauri-icons");
const masterPng = path.resolve(desktopRoot, "..", "..", "assets", "branding", "skillhub-app-icon-master.png");

const tauriConfig: {
  bundle?: {
    icon?: string[];
    windows?: { nsis?: { installerIcon?: string } };
  };
  app?: { windows?: Record<string, unknown>[] };
} = JSON.parse(readFileSync(path.join(tauriRoot, "tauri.conf.json"), "utf8"));

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

/** PNG 头部：签名 8 字节 + IHDR（宽高/位深/颜色类型）。 */
function readPngHeader(buffer: Buffer): PngHeader {
  expect(buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(buffer.readUInt32BE(8), "first chunk must be IHDR").toBe(13);
  expect(buffer.toString("ascii", 12, 16)).toBe("IHDR");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}

interface IcoEntry {
  width: number;
  height: number;
}

/** ICO 目录：ICONDIR + 每图一项；宽高字节 0 表示 256。 */
function readIcoEntries(buffer: Buffer): IcoEntry[] {
  expect(buffer.readUInt16LE(0)).toBe(0);
  expect(buffer.readUInt16LE(2), "ICO type must be icon").toBe(1);
  const count = buffer.readUInt16LE(4);
  const entries: IcoEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    entries.push({ width: buffer[offset] || 256, height: buffer[offset + 1] || 256 });
  }
  return entries;
}

/** @2x 等别名换算成实际像素；无法识别的命名回退 0（不做尺寸断言）。 */
function expectedPngSize(fileName: string): number {
  const base = path.basename(fileName);
  const match = base.match(/^(\d+)x\1(@2x)?\.png$/);
  if (!match) return 0;
  return Number(match[1]) * (match[2] ? 2 : 1);
}

/** 母版几何参数（与 assets/branding/generate-macos-icon.py 的常量一致）。 */
const MASTER_CANVAS = 1024;
const MASTER_OUTER_FRACTION_RANGE = [0.86, 0.88] as const;
const MASTER_MARGIN_FRACTION_RANGE = [0.06, 0.07] as const;

/**
 * 候选母版几何参数（D5-11 macOS Dock 视觉偏大整改，OPT-20260914-06）。
 *
 * 现状母版外层 896（87.5%）/ 边距 64（6.25%）在 Dock 中与相邻 App 并排时
 * 仍显得略大（人工验收边界，非回归）。候选“仅切掉更多暗色背景、不重绘品牌
 * 图形”：外层 864（84.4%）、边距 80（7.8%），品牌主标记随外层等比缩小。
 *
 * 测试区间同时充当护栏：外层上限 0.87 低于现状 0.875，边距下限 0.07 高于现状
 * 0.0625 —— 一旦有人把暗色背景放大回旧尺寸，候选测试即报红，防止视觉偏大
 * 再次悄悄回归。母版（现状基线）测试区间保持不变，作为可回滚保证。
 */
const masterCandidatePng = path.resolve(desktopRoot, "..", "..", "assets", "branding", "skillhub-app-icon-master-candidate.png");
const MASTER_CANDIDATE_OUTER_FRACTION_RANGE = [0.82, 0.87] as const;
const MASTER_CANDIDATE_MARGIN_FRACTION_RANGE = [0.07, 0.10] as const;

interface DecodedPngRgba {
  width: number;
  height: number;
  /** 返回 (x, y) 处的 alpha（0-255）；坐标越界时返回 0（视作透明）。 */
  alphaAt(x: number, y: number): number;
}

/**
 * 最简 PNG 扫描线解码：仅支持本仓库图标产出的 8bit、colorType 6（RGBA）、
 * 非隔行图像。只解压 IDAT 并手工反滤波，用于对母版做逐像素 alpha 几何
 * 断言——不引入任何 npm 依赖。
 */
function decodePngRgba(buffer: Buffer): DecodedPngRgba {
  const header = readPngHeader(buffer);
  expect(header.bitDepth, "decoder supports 8bit channels only").toBe(8);
  expect(header.colorType, "decoder supports RGBA (colorType 6) only").toBe(6);
  expect(buffer[28], "decoder supports non-interlaced PNG only").toBe(0);

  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") break;
    offset += 12 + length;
  }
  expect(idat.length, "PNG must contain IDAT").toBeGreaterThan(0);

  const { width, height } = header;
  const bpp = 4;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length, "inflated scanlines must match the header dimensions").toBe((stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);

  const paethPredictor = (left: number, up: number, upperLeft: number): number => {
    const p = left + up - upperLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - up);
    const pc = Math.abs(p - upperLeft);
    if (pa <= pb && pa <= pc) return left;
    return pb <= pc ? up : upperLeft;
  };

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * stride;
    const rawStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[rawStart + x];
      const left = x >= bpp ? pixels[rowStart + x - bpp] : 0;
      const up = y > 0 ? pixels[rowStart - stride + x] : 0;
      const upperLeft = y > 0 && x >= bpp ? pixels[rowStart - stride + x - bpp] : 0;
      let value: number;
      if (filter === 1) value = rawByte + left;
      else if (filter === 2) value = rawByte + up;
      else if (filter === 3) value = rawByte + ((left + up) >> 1);
      else if (filter === 4) value = rawByte + paethPredictor(left, up, upperLeft);
      else value = rawByte;
      pixels[rowStart + x] = value & 0xff;
    }
  }

  return {
    width,
    height,
    alphaAt(x: number, y: number): number {
      if (x < 0 || y < 0 || x >= width || y >= height) return 0;
      return pixels[(y * width + x) * bpp + 3];
    },
  };
}

/** 不透明（alpha 达到阈值）像素的包围盒与四侧边距。 */
function opaqueBounds(image: DecodedPngRgba, threshold = 128): { left: number; top: number; right: number; bottom: number } {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.alphaAt(x, y) >= threshold) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  expect(right, "master must contain opaque pixels").toBeGreaterThanOrEqual(0);
  return { left, top, right, bottom };
}

/**
 * macOS 母版（现状母版或候选母版）的几何护栏：1024×1024 RGBA、四角与四边
 * 中点透明（圆角外层，Dock 中不再直角黑底）、中心不透明、外层占比与四周透明
 * 边距落在给定区间内、且外层为“圆角矩形”而非方形切角或整圆。master 基线测试
 * 与候选测试共用此函数，仅传入不同的区间常量，避免重复断言。
 */
function assertMacOsMasterGeometry(
  masterPath: string,
  canvas: number,
  outerRange: readonly [number, number],
  marginRange: readonly [number, number],
  label: string,
): void {
  const master = readPngHeader(readFileSync(masterPath));
  expect(master.width, `${label} canvas is ${canvas}px wide`).toBe(canvas);
  expect(master.height, `${label} canvas is ${canvas}px tall`).toBe(canvas);
  expect(master.colorType, `${label} keeps an alpha channel`).toBe(6);

  const image = decodePngRgba(readFileSync(masterPath));
  // 画布四角与四边中点都落在透明边距/圆角外：Dock 中不再出现直角黑底。
  const corners: Array<[number, number]> = [
    [0, 0],
    [canvas - 1, 0],
    [0, canvas - 1],
    [canvas - 1, canvas - 1],
  ];
  for (const [x, y] of corners) {
    expect(image.alphaAt(x, y), `${label} corner (${x},${y}) stays transparent`).toBe(0);
  }
  const edgeMidpoints: Array<[number, number]> = [
    [0, canvas >> 1],
    [canvas - 1, canvas >> 1],
    [canvas >> 1, 0],
    [canvas >> 1, canvas - 1],
  ];
  for (const [x, y] of edgeMidpoints) {
    expect(image.alphaAt(x, y), `${label} edge midpoint (${x},${y}) stays transparent`).toBe(0);
  }
  expect(image.alphaAt(canvas >> 1, canvas >> 1), `${label} center stays opaque`).toBe(255);

  const bounds = opaqueBounds(image);
  const side = Math.max(bounds.right - bounds.left + 1, bounds.bottom - bounds.top + 1);
  const sideFraction = side / canvas;
  expect(
    sideFraction,
    `${label} rounded outer tile must span ${outerRange[0] * 100}-${outerRange[1] * 100}% of the canvas (got ${(sideFraction * 100).toFixed(2)}%)`,
  ).toBeGreaterThanOrEqual(outerRange[0]);
  expect(sideFraction).toBeLessThanOrEqual(outerRange[1]);

  // 四周透明边距。
  const margins = {
    left: bounds.left,
    top: bounds.top,
    right: canvas - 1 - bounds.right,
    bottom: canvas - 1 - bounds.bottom,
  };
  for (const [edge, margin] of Object.entries(margins)) {
    const fraction = margin / canvas;
    expect(
      fraction,
      `${label} ${edge} margin must stay within ${marginRange[0] * 100}-${marginRange[1] * 100}% of the canvas (got ${(fraction * 100).toFixed(2)}%)`,
    ).toBeGreaterThanOrEqual(marginRange[0]);
    expect(fraction).toBeLessThanOrEqual(marginRange[1]);
  }

  // 圆角几何：包围盒四角（若为直角应不透明）必须透明；沿边向内越过圆角切点后
  // 必须不透明——锁定“圆角矩形”而非方形切角或整圆。
  const cornerPoints: Array<[number, number]> = [
    [bounds.left, bounds.top],
    [bounds.right, bounds.top],
    [bounds.left, bounds.bottom],
    [bounds.right, bounds.bottom],
  ];
  for (const [x, y] of cornerPoints) {
    expect(image.alphaAt(x, y), `${label} outer tile corner (${x},${y}) must be rounded away`).toBeLessThan(128);
  }
  const inset = Math.round(side * 0.25);
  const insideEdgePoints: Array<[number, number]> = [
    [bounds.left + inset, bounds.top + 1],
    [bounds.right - inset, bounds.top + 1],
    [bounds.left + 1, bounds.top + inset],
    [bounds.left + inset, bounds.bottom - 1],
  ];
  for (const [x, y] of insideEdgePoints) {
    expect(image.alphaAt(x, y), `${label} outer tile edge (${x},${y}) must be opaque past the corner arc`).toBeGreaterThanOrEqual(128);
  }
}

it("points the bundle, the window and the NSIS installer at a controlled icon set", () => {
  const iconList = tauriConfig.bundle?.icon;
  expect(Array.isArray(iconList)).toBe(true);
  expect(iconList!.length, "bundle.icon must not be empty (0.2.0 black-frame feedback)").toBeGreaterThan(0);
  for (const rel of iconList!) {
    expect(rel, "icon paths stay inside the versioned icons directory").toMatch(/^icons\//);
  }
  // 平台清单：Windows 安装器/二进制用 ico，macOS 用 icns，PNG 覆盖通用窗口图标。
  expect(iconList!.some((rel) => rel.endsWith(".ico"))).toBe(true);
  expect(iconList!.some((rel) => rel.endsWith(".icns"))).toBe(true);
  expect(iconList!.filter((rel) => rel.endsWith(".png")).length).toBeGreaterThanOrEqual(3);
  // Windows 任务栏/标题栏窗口图标：仓库钉住的 Tauri 2.x 的 WindowConfig
  // 没有 icon 字段（cargo check 会拒绝未知字段）；tauri-build 与
  // generate_context! 会自动取 bundle.icon 里第一个 .ico 作为可执行文件
  // 资源与默认窗口图标——因此该 ico 必须在清单内，而窗口配置不得携带
  // 不受支持的 icon 键。
  expect(iconList).toContain("icons/icon.ico");
  expect(tauriConfig.app?.windows?.[0]?.icon).toBeUndefined();
  // NSIS 安装器图标。
  expect(tauriConfig.bundle?.windows?.nsis?.installerIcon).toBe("icons/icon.ico");
});

it("ships every referenced icon with correct format and dimensions", () => {
  const referenced = [...(tauriConfig.bundle?.icon ?? [])];
  const installerIcon = tauriConfig.bundle?.windows?.nsis?.installerIcon;
  if (installerIcon) referenced.push(installerIcon);

  for (const rel of new Set(referenced)) {
    const file = path.join(tauriRoot, rel);
    expect(existsSync(file), `${rel} must exist`).toBe(true);
    const buffer = readFileSync(file);
    if (rel.endsWith(".png")) {
      const header = readPngHeader(buffer);
      // 图标带透明通道（RGBA）；不透明源图会在深色任务栏上呈现方块黑底。
      expect(header.colorType, `${rel} keeps the alpha channel`).toBe(6);
      const expected = expectedPngSize(rel);
      if (expected > 0) {
        expect(header.width, rel).toBe(expected);
        expect(header.height, rel).toBe(expected);
      }
    }
    if (rel.endsWith(".ico")) {
      const entries = readIcoEntries(buffer);
      expect(entries.length, "icon.ico embeds multiple sizes").toBeGreaterThanOrEqual(4);
      expect(entries.some((entry) => entry.width === 256), "icon.ico includes a 256px entry").toBe(true);
      expect(entries.every((entry) => entry.width === entry.height), "icon.ico entries are square").toBe(true);
    }
    if (rel.endsWith(".icns")) {
      expect(buffer.toString("ascii", 0, 4)).toBe("icns");
      expect(buffer.readUInt32BE(4)).toBe(buffer.length);
    }
  }
});

it("matches the controlled master artwork byte for byte", () => {
  expect(existsSync(masterPng), "master artwork stays in assets/branding").toBe(true);
  const master = readPngHeader(readFileSync(masterPng));
  expect(master.width).toBe(master.height);
  // 母本即 macOS 形状源：1024×1024 RGBA（圆角外层 + 透明边距）；接入用 PNG
  // 由 sips 从母本缩放生成并保留 alpha。受控副本必须与 assets/branding
  // 母本逐字节一致。
  for (const rel of tauriConfig.bundle?.icon ?? []) {
    const source = path.join(masterSourceRoot, path.basename(rel));
    expect(existsSync(source), `${source} master must exist`).toBe(true);
    const copy = readFileSync(path.join(tauriRoot, rel));
    expect(copy.equals(readFileSync(source)), `${rel} is a byte-identical controlled copy`).toBe(true);
  }
});

it("ships the macOS master as a 1024x1024 RGBA canvas with transparent margins", () => {
  // 现状母版即回滚基线：保留旧几何（外层 86%-88% / 边距 6%-7%）以证明可回退。
  assertMacOsMasterGeometry(masterPng, MASTER_CANVAS, MASTER_OUTER_FRACTION_RANGE, MASTER_MARGIN_FRACTION_RANGE, "macOS master");
});

it("ships the macOS candidate master as a 1024x1024 RGBA canvas with a larger transparent margin (D5-11 Dock-optical-size guardrail)", () => {
  // 候选母版：仅放大透明边距（外层 84.4% / 边距 7.8%）以缓解 Dock 中视觉偏大。
  // 区间上限 0.87 < 现状 0.875、边距下限 0.07 > 现状 0.0625，构成护栏防回归。
  expect(existsSync(masterCandidatePng), "candidate macOS master must exist").toBe(true);
  assertMacOsMasterGeometry(masterCandidatePng, MASTER_CANVAS, MASTER_CANDIDATE_OUTER_FRACTION_RANGE, MASTER_CANDIDATE_MARGIN_FRACTION_RANGE, "macOS candidate master");
});
