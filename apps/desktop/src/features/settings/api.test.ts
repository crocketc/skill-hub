import { beforeEach, expect, it, vi } from "vitest";
import { nativeApplicationUpdateOperations } from "./api";

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));

vi.mock("../../api/bindings", () => mocks);

const manifest = {
  version: "0.2.0",
  notes: "稳定更新流程",
  published_at: null,
  artifacts: [
    {
      target: "windows-x86_64",
      url: "https://github.com/crocketc/skill-hub/releases/download/v0.2.0/SkillHub.nsis.zip",
      size: "4",
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      signature: "trusted-signature",
    },
  ],
};

const platform = { target: "windows", arch: "x86_64" };
const artifact = manifest.artifacts[0];

beforeEach(() => {
  mocks.executeCommand.mockReset();
  mocks.queryApplication.mockReset();
});

it("hands the checked manifest to native prepare and download commands", async () => {
  mocks.queryApplication.mockResolvedValue({
    type: "application_update",
    payload: {
      available: true,
      current_version: "0.1.0",
      latest_version: "0.2.0",
      release_url: "https://github.com/crocketc/skill-hub/releases/tag/v0.2.0",
      asset_name: "SkillHub.nsis.zip",
      manifest,
      platform,
      published_at: null,
      install_action: "install_verified_asset",
    },
  });
  mocks.executeCommand
    .mockResolvedValueOnce({ type: "prepared_application_update", payload: { manifest, artifact, state: "ready_to_install" } })
    .mockResolvedValueOnce({ type: "downloaded_application_update", payload: { artifact, state: "ready_to_install" } });

  const operations = nativeApplicationUpdateOperations({
    currentVersion: async () => "0.1.0",
    buildTrust: () => "windows_unsigned",
  });

  const update = await operations.check();
  expect(update?.manifest).toEqual(manifest);
  expect(update?.platform).toEqual(platform);
  expect(update?.notes).toBe("稳定更新流程");
  expect(update?.assetName).toBe("SkillHub.nsis.zip");
  expect(update?.assetUrl).toBe(artifact.url);
  expect(update?.sha256).toBe(artifact.sha256);
  expect(update?.sizeBytes).toBe(4);

  await operations.download();

  expect(mocks.executeCommand).toHaveBeenNthCalledWith(1, {
    type: "prepare_application_update",
    payload: { current_version: "0.1.0", manifest, platform },
  });
  expect(mocks.executeCommand).toHaveBeenNthCalledWith(2, {
    type: "download_application_update",
    payload: { artifact },
  });
});

it("installs a downloaded update through the native command", async () => {
  mocks.executeCommand.mockResolvedValue({ type: "application_update_state", payload: "ready_to_install" });

  const operations = nativeApplicationUpdateOperations({
    currentVersion: async () => "0.1.0",
    buildTrust: () => "windows_unsigned",
  });

  await operations.install();

  expect(mocks.executeCommand).toHaveBeenCalledWith({ type: "install_application_update", payload: null });
});
