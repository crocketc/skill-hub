import { desktopDirectoryPicker, normalizeWindowsPath } from "./directoryPicker";

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
