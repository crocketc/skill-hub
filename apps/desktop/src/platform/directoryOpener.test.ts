import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopDirectoryOpener } from "./directoryOpener";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("desktopDirectoryOpener", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("forwards the path to the native open command", async () => {
    invoke.mockResolvedValue(null);
    await desktopDirectoryOpener.openDirectory("C:/Users/demo/SkillHub");
    expect(invoke).toHaveBeenCalledWith("open_local_directory", {
      path: "C:/Users/demo/SkillHub",
    });
  });

  it("propagates native failures instead of faking success", async () => {
    invoke.mockRejectedValue("open_directory.not_a_directory");
    await expect(
      desktopDirectoryOpener.openDirectory("C:/not-a-dir"),
    ).rejects.toMatch("open_directory.not_a_directory");
  });
});
