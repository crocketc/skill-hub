import { invoke } from "@tauri-apps/api/core";

export interface DirectoryPicker {
  pickDirectory: () => Promise<string | null>;
}

export const desktopDirectoryPicker: DirectoryPicker = {
  pickDirectory: () => invoke<string | null>("pick_local_directory"),
};
