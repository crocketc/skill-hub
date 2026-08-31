import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { ApplicationUpdate } from "./ApplicationUpdate";
import type { AppUpdate, UpdatePolicy, UpdateProgress, UpdateState } from "./api";

const update: AppUpdate = {
  version: "0.2.0",
  notes: "改进桌面端体验",
  releaseUrl: "https://github.com/crocketc/skill-hub/releases/latest",
  assetName: "SkillHub_0.2.0_x64.nsis.zip",
  assetUrl: "https://github.com/crocketc/skill-hub/releases/download/v0.2.0/SkillHub_0.2.0_x64.nsis.zip",
  sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  sizeBytes: 42,
};

const policy: UpdatePolicy = { enabled: true, checkOnStartup: true };

async function renderCard(props: Partial<Parameters<typeof ApplicationUpdate>[0]> = {}) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <ApplicationUpdate policy={policy} state="not_checked" update={null} {...props} />
    </I18nextProvider>,
  );
}

it("asks the facade to check for updates from the idle state", async () => {
  const user = userEvent.setup();
  const onCheck = vi.fn();
  await renderCard({ onCheck });

  await user.click(screen.getByRole("button", { name: "检查更新" }));

  expect(onCheck).toHaveBeenCalledTimes(1);
});

it("shows the up-to-date notice without install actions", async () => {
  await renderCard({ state: "up_to_date" });

  expect(screen.getByText("当前已是最新版本。")).toBeVisible();
  expect(screen.queryByRole("button", { name: "立即安装" })).not.toBeInTheDocument();
});

it("shows download progress and cancel action", async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  const progress: UpdateProgress = { receivedBytes: 42, totalBytes: 100 };
  await renderCard({ progress, state: "downloading", update, onCancel });

  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  expect(screen.queryByRole("button", { name: "立即安装" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "取消下载" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it("offers install only after verification succeeded", async () => {
  const user = userEvent.setup();
  const onInstall = vi.fn();
  await renderCard({ state: "ready_to_install", update, onInstall });

  const install = screen.getByRole("button", { name: "立即安装" });
  expect(install).toBeEnabled();
  expect(screen.getByText(/自动重启/)).toBeVisible();

  await user.click(install);
  expect(onInstall).toHaveBeenCalledTimes(1);
});

it("exposes source and hash in developer details", async () => {
  const user = userEvent.setup();
  await renderCard({ state: "ready_to_install", update });

  await user.click(screen.getByText("开发者详情"));

  expect(screen.getByText(update.assetUrl as string)).toBeVisible();
  expect(screen.getByText(update.sha256 as string)).toBeVisible();
});

it("maps verification failure to an actionable message and retry", async () => {
  const user = userEvent.setup();
  const onDownload = vi.fn();
  await renderCard({
    state: "failed",
    update,
    errorCode: "application_update.integrity_failed",
    onDownload,
  });

  expect(screen.getByText(/校验失败/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "立即安装" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "重试" }));
  expect(onDownload).toHaveBeenCalledTimes(1);
});

it("explains rollback after a failed install and offers re-download", async () => {
  const user = userEvent.setup();
  const onDownload = vi.fn();
  const onRollback = vi.fn();
  await renderCard({ state: "rolled_back", update, onDownload, onRollback });

  expect(screen.getByText(/已恢复上一版本/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "重新下载" }));
  expect(onDownload).toHaveBeenCalledTimes(1);
});

it("keeps the official release page as the unsigned fallback", async () => {
  const user = userEvent.setup();
  const onOpenRelease = vi.fn();
  await renderCard({
    buildTrust: "windows_unsigned",
    state: "available",
    update,
    onOpenRelease,
  });

  expect(screen.getByText(/未签名构建/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "打开 GitHub Release" }));
  expect(onOpenRelease).toHaveBeenCalledTimes(1);
});

it("reports the phase as checking while a check is in flight", async () => {
  await renderCard({ state: "checking" });

  expect(screen.getByText("正在检查更新…")).toBeVisible();
});

it("declares the update state contract", async () => {
  const states: UpdateState[] = [
    "not_checked",
    "checking",
    "up_to_date",
    "available",
    "downloading",
    "verifying",
    "ready_to_install",
    "failed",
    "rolled_back",
  ];
  expect(states).toHaveLength(9);
});
