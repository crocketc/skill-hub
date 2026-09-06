import { invoke } from "@tauri-apps/api/core";

export interface AppRestarter {
  /** Restarts the desktop application so persisted settings take effect. */
  restart: () => Promise<void>;
}

export const desktopRestarter: AppRestarter = {
  async restart() {
    await invoke("restart_application");
  },
};
