import { invoke } from "@tauri-apps/api/core";

export interface DirectoryPicker {
  pickDirectory: () => Promise<string | null>;
}

export function normalizeWindowsPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
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
