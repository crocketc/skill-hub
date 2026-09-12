import { act, render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import type { ScanResult } from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import {
  beginBackgroundScan,
  resetBackgroundScan,
  type AppNotice,
  type NotifyFunction,
} from "./backgroundScan";
import { BackgroundScanNotifier } from "./BackgroundScanNotifier";

const scanResult: ScanResult = {
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
  visited_paths: ["C:\\Users\\Test\\.codex\\skills"],
  reparsed_count: 1,
  unchanged_count: 0,
  errors: [],
};

function renderNotifier(notify: NotifyFunction, i18n: Awaited<ReturnType<typeof createSkillHubI18n>>) {
  return render(<BackgroundScanNotifier notify={notify} />, {
    wrapper: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider>,
  });
}

it("raises one success notice with the batch-import action when the scan completes", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const notify = vi.fn((_notice: AppNotice) => "notice-1");
  resetBackgroundScan();
  const view = renderNotifier(notify, i18n);

  beginBackgroundScan(Promise.resolve({ kind: "completed", result: scanResult }), []);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(notify).toHaveBeenCalledTimes(1);
  const notice = notify.mock.calls[0][0];
  expect(notice.tone).toBe("success");
  expect(notice.title).toBe("后台扫描完成");
  expect(notice.detail).toContain("发现 1 个 Skill");
  expect(notice.action).toEqual({ label: "打开批量导入", to: "/discovery/local" });

  // The terminal state is reported exactly once, even across re-renders.
  view.rerender(<BackgroundScanNotifier notify={notify} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(notify).toHaveBeenCalledTimes(1);
});

it("raises one readable failure notice with the retry entry when the scan fails", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const notify = vi.fn((_notice: AppNotice) => "notice-2");
  resetBackgroundScan();
  renderNotifier(notify, i18n);

  beginBackgroundScan(
    Promise.reject({ code: "input.invalid", severity: "error", params: {}, actions: [] }),
    [],
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(notify).toHaveBeenCalledTimes(1);
  const notice = notify.mock.calls[0][0];
  expect(notice.tone).toBe("warning");
  expect(notice.title).toBe("后台扫描失败");
  // T3 的集中错误 presenter 将 input.invalid 映射为可读文案；通知明细不得含裸码。
  expect(notice.detail).toBe("输入未通过校验，请检查填写内容后重试。");
  expect(notice.detail).not.toContain("input.invalid");
  expect(notice.action).toEqual({ label: "重试", to: "/initialize" });
});

it("stays silent and renders nothing while a handed-off scan is still running", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const notify = vi.fn((_notice: AppNotice) => "notice-3");
  resetBackgroundScan();
  const { container } = renderNotifier(notify, i18n);

  beginBackgroundScan(new Promise(() => undefined), []);
  await act(async () => {
    await Promise.resolve();
  });

  expect(notify).not.toHaveBeenCalled();
  expect(container).toBeEmptyDOMElement();
});
