import { invoke } from "@tauri-apps/api/core";

export interface DirectoryOpener {
  /** 用系统文件管理器打开一个本机目录（N11：打开集中库目录）。 */
  openDirectory: (path: string) => Promise<void>;
}

export const desktopDirectoryOpener: DirectoryOpener = {
  async openDirectory(path) {
    await invoke("open_local_directory", { path });
  },
};
