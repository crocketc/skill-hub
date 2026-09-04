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
    const path = await invoke<string | null>("pick_local_directory");
    return path ? normalizeWindowsPath(path) : null;
  },
};
