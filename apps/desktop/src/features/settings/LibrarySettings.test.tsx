import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { HealthReport } from "../../api/bindings";
import { settingsFixture } from "./api";
import { LibrarySettings } from "./LibrarySettings";

function report(findings: HealthReport["findings"]): HealthReport {
  return { id: "op-health-1", findings };
}

async function renderLibrary(health: { runHealthCheck: () => Promise<HealthReport> }) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <LibrarySettings health={health} settings={settingsFixture()} />
    </I18nextProvider>,
  );
}

it("runs a library health check and shows each finding", async () => {
  const runHealthCheck = vi.fn(async () =>
    report([{ code: "orphan_metadata", severity: "warning", repair: "remove_orphan_metadata" }]),
  );
  await renderLibrary({ runHealthCheck });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "运行健康检查" }));
    await Promise.resolve();
  });

  expect(runHealthCheck).toHaveBeenCalledWith();
  expect(await screen.findByText("发现 1 个问题")).toBeVisible();
  expect(screen.getByText("orphan_metadata")).toBeVisible();
  expect(screen.getByText("警告")).toBeVisible();
});

it("shows the all-clear message when the health check finds nothing", async () => {
  const runHealthCheck = vi.fn(async () => report([]));
  await renderLibrary({ runHealthCheck });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "运行健康检查" }));
    await Promise.resolve();
  });

  expect(await screen.findByText("未发现问题")).toBeVisible();
});

it("shows an error message when the health check fails", async () => {
  const runHealthCheck = vi.fn(async () => {
    throw new Error("native unavailable");
  });
  await renderLibrary({ runHealthCheck });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "运行健康检查" }));
    await Promise.resolve();
  });

  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByText("健康检查失败，请稍后重试")).toBeVisible();
});
