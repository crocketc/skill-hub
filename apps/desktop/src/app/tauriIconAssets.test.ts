import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
  // 母本允许不带透明通道（本仓库母本为 RGB 方图）；接入用 PNG 由图标工具
  // 生成并自带 alpha。受控副本必须与 assets/branding 母本逐字节一致。
  for (const rel of tauriConfig.bundle?.icon ?? []) {
    const source = path.join(masterSourceRoot, path.basename(rel));
    expect(existsSync(source), `${source} master must exist`).toBe(true);
    const copy = readFileSync(path.join(tauriRoot, rel));
    expect(copy.equals(readFileSync(source)), `${rel} is a byte-identical controlled copy`).toBe(true);
  }
});
