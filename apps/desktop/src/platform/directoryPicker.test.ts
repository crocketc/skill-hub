import { desktopDirectoryPicker, normalizeWindowsPath, sameSourcePath } from "./directoryPicker";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
});

it("returns the normalized path from a successful host payload", async () => {
  invokeMock.mockResolvedValue(
    JSON.stringify({ path: "\\\\?\\D:\\Hub", grant_id: "\\\\?\\D:\\Hub" }),
  );

  await expect(desktopDirectoryPicker.pickDirectory()).resolves.toBe("D:\\Hub");
  expect(invokeMock).toHaveBeenCalledWith("pick_local_directory");
});

it("still returns the path when the host could not issue a path grant", async () => {
  invokeMock.mockResolvedValue(JSON.stringify({ path: "D:\\Hub", grant_id: null }));

  await expect(desktopDirectoryPicker.pickDirectory()).resolves.toBe("D:\\Hub");
});

it("still returns the path when the host omits the grant id", async () => {
  invokeMock.mockResolvedValue(JSON.stringify({ path: "D:\\Hub" }));

  await expect(desktopDirectoryPicker.pickDirectory()).resolves.toBe("D:\\Hub");
});

it("reports a cancelled picker as null instead of a path", async () => {
  invokeMock.mockResolvedValue(null);

  await expect(desktopDirectoryPicker.pickDirectory()).resolves.toBeNull();
});

it("strips the Windows extended-length prefix from normalized paths", () => {
  expect(normalizeWindowsPath("\\\\?\\C:\\Hub")).toBe("C:\\Hub");
  expect(normalizeWindowsPath("\\\\?\\UNC\\server\\share")).toBe("\\\\server\\share");
  expect(normalizeWindowsPath("C:\\Hub")).toBe("C:\\Hub");
});

it("folds case only between two Windows-shaped paths", () => {
  expect(sameSourcePath("C:/codex/skills", "c:/CODEX/Skills")).toBe(true);
  expect(sameSourcePath("C:\\Hub", "C:\\hub")).toBe(true);
  expect(sameSourcePath("\\\\Server\\Share", "\\\\server\\share")).toBe(true);
});

it("keeps case-variant POSIX paths distinct for case-sensitive volumes", () => {
  expect(sameSourcePath("/Users/a/Skills", "/users/a/skills")).toBe(false);
  expect(sameSourcePath("/Users/a/Skills", "/Users/a/Skills")).toBe(true);
});

it("treats mixed-shape paths as distinct instead of guessing the volume", () => {
  expect(sameSourcePath("C:/codex/skills", "/users/a/skills")).toBe(false);
  expect(sameSourcePath("relative/skills", "Relative/Skills")).toBe(false);
});
