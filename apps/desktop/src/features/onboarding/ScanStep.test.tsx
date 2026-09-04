import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import type { ScanResult } from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import { ScanStep } from "./ScanStep";

it("renders a read-only scan preview without import actions", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const onOpenImport = vi.fn();
  const result: ScanResult = {
    generation: { generation: 1, observed_at: 1 },
    roots: ["C:\\Users\\Test\\.codex\\skills"],
    discovered: [
      {
        root: "C:\\Users\\Test\\.codex\\skills",
        relative_path: "alpha",
        path: "C:\\Users\\Test\\.codex\\skills\\alpha",
        marker: "SKILL.md",
        marker_size: 12,
        marker_modified_at: 1,
        size: 12,
        latest_modified_at: 1,
        fingerprint: "a",
        metadata_fingerprint: "b",
      },
    ],
    visited_paths: ["C:\\Users\\Test\\.codex\\skills", "C:\\Users\\Test\\.codex\\skills\\alpha"],
    reparsed_count: 1,
    unchanged_count: 0,
    errors: [{ path: "C:\\Users\\Test\\.codex\\skills\\broken", code: "permission_denied" }],
  };

  render(
    <I18nextProvider i18n={i18n}>
      <ScanStep isScanning={false} onOpenImport={onOpenImport} onScan={() => undefined} scanResult={result} />
    </I18nextProvider>,
  );

  expect(screen.getByRole("heading", { name: "扫描预览" })).toBeVisible();
  expect(screen.getByText("发现 1 个 Skill")).toBeVisible();
  expect(screen.getByText("扫描 2 个路径")).toBeVisible();
  expect(screen.getByText("问题 1 个")).toBeVisible();
  expect(screen.getByText("alpha")).toBeVisible();
  expect(screen.getByText("C:\\Users\\Test\\.codex\\skills\\alpha")).toBeVisible();
  expect(screen.getByRole("button", { name: "进入批量导入" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "导入" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));
  fireEvent.click(screen.getByRole("button", { name: "进入批量导入" }));
  expect(onOpenImport).toHaveBeenCalledWith(result.roots);
});

it("offers background continuation while a scan is running", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ScanStep isScanning onContinueInBackground={() => undefined} onScan={() => undefined} />
    </I18nextProvider>,
  );

  expect(screen.getByRole("button", { name: "转入后台，继续完成初始化" })).toBeVisible();
});

it("prevents starting a second scan after handing the first one to the background", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ScanStep isScanning={false} onScan={() => undefined} scanInBackground />
    </I18nextProvider>,
  );

  expect(screen.getByRole("button", { name: "开始只读扫描" })).toBeDisabled();
});
