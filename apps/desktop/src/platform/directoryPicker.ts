import { invoke } from "@tauri-apps/api/core";

export interface DirectoryPicker {
  pickDirectory: () => Promise<string | null>;
}

export function normalizeWindowsPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

/**
 * 来源去重的路径同一性比较。Windows 卷大小写不敏感，Windows 形态路径
 * （盘符/UNC）折叠大小写；POSIX 路径不折叠——macOS 卷可能被格式化为
 * 大小写敏感，折叠会把两个真实存在的不同目录并成一个。宁可让大小写
 * 不敏感卷上出现可手动移除的重复条目，也不误并不同目录。
 */
export function sameSourcePath(a: string, b: string): boolean {
  const windowsShaped = (path: string): boolean =>
    /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
  if (windowsShaped(a) && windowsShaped(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

export const desktopDirectoryPicker: DirectoryPicker = {
  async pickDirectory() {
    // 命令返回 JSON 字符串 {path, grant_id}（grant_id 即规范化路径，
    // 宿主已在选取时注册为路径 grant，自定义 Agent 表单可直接引用）。
    // grant 签发是尽力而为（AR-007）：签发失败时宿主返回 grant_id 为
    // null/缺省的载荷，路径本身仍然有效，必须照常返回。
    const raw = await invoke<string | null>("pick_local_directory");
    if (!raw) return null;
    const picked = JSON.parse(raw) as { path: string; grant_id?: string | null };
    return normalizeWindowsPath(picked.path);
  },
};
