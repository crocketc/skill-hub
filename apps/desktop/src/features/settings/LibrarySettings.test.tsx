import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { HealthReport, IgnoreRule, RepairPlan } from "../../api/bindings";
import { settingsFixture, type LibraryHealthOperations } from "./api";
import { LibrarySettings } from "./LibrarySettings";

function report(findings: HealthReport["findings"]): HealthReport {
  return { id: "op-health-1", findings };
}

const pathRule: IgnoreRule = {
  id: "rule-1",
  subject: { type: "exact_path", value: "C:/SkillHub/library/drafts" },
  reason: "草稿目录不参与检查",
  created_at: "2026-09-01T08:00:00Z",
  defer_until: null,
};

const skillRule: IgnoreRule = {
  id: "rule-2",
  subject: { type: "exact_skill", value: "pdf-helper" },
  reason: "稳定复现问题，先跳过",
  created_at: "2026-09-02T08:00:00Z",
  defer_until: null,
};

const plan: RepairPlan = {
  id: "op-repair-1",
  report_id: "op-health-1",
  finding_index: 0,
  finding: { code: "orphan_metadata", severity: "warning", repair: "remove_orphan_metadata" },
};

function healthFacade(overrides: Partial<LibraryHealthOperations> = {}): LibraryHealthOperations {
  return {
    runHealthCheck: async () => report([]),
    listIgnoreRules: async () => [],
    createIgnoreRule: async (draft) => ({
      id: "rule-new",
      subject: draft.subject,
      reason: draft.reason,
      created_at: "2026-09-06T08:00:00Z",
      defer_until: draft.deferUntil,
    }),
    removeIgnoreRule: async () => undefined,
    prepareRepair: async () => {
      throw new Error("prepare_repair is not expected in this test");
    },
    commitRepair: async () => {
      throw new Error("commit_repair is not expected in this test");
    },
    ...overrides,
  };
}

async function renderLibrary(health: LibraryHealthOperations) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <LibrarySettings health={health} settings={settingsFixture()} />
    </I18nextProvider>,
  );
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

it("runs a library health check and shows each finding", async () => {
  const runHealthCheck = vi.fn(async () =>
    report([{ code: "orphan_metadata", severity: "warning", repair: "remove_orphan_metadata" }]),
  );
  await renderLibrary(healthFacade({ runHealthCheck }));

  await click(screen.getByRole("button", { name: "运行健康检查" }));

  expect(runHealthCheck).toHaveBeenCalledWith();
  expect(await screen.findByText("发现 1 个问题")).toBeVisible();
  expect(screen.getByText("orphan_metadata")).toBeVisible();
  expect(screen.getByText("警告")).toBeVisible();
});

it("states the health check scope honestly before running it", async () => {
  await renderLibrary(healthFacade());

  // AR-004：用户需要知道检查覆盖什么、不覆盖什么（例如重名/重复不属于范围）。
  expect(
    screen.getByText(/只检查未完成的应用操作/),
  ).toBeVisible();
  expect(screen.getByText(/不包含重名或重复内容检测/)).toBeVisible();
});

it("shows the all-clear message when the health check finds nothing", async () => {
  await renderLibrary(healthFacade());

  await click(screen.getByRole("button", { name: "运行健康检查" }));

  expect(await screen.findByText("未发现问题")).toBeVisible();
});

it("shows an error message when the health check fails", async () => {
  const runHealthCheck = vi.fn(async () => {
    throw new Error("native unavailable");
  });
  await renderLibrary(healthFacade({ runHealthCheck }));

  await click(screen.getByRole("button", { name: "运行健康检查" }));

  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByText("健康检查失败，请稍后重试")).toBeVisible();
});

it("lists existing ignore rules with subject, reason and creation time", async () => {
  const listIgnoreRules = vi.fn(async () => [pathRule, skillRule]);
  await renderLibrary(healthFacade({ listIgnoreRules }));

  expect(await screen.findByText("C:/SkillHub/library/drafts")).toBeVisible();
  expect(screen.getByText("pdf-helper")).toBeVisible();
  expect(screen.getByText("草稿目录不参与检查")).toBeVisible();
  expect(screen.getByText("稳定复现问题，先跳过")).toBeVisible();
  expect(screen.getByText("创建于: 2026-09-01T08:00:00Z")).toBeVisible();
  expect(listIgnoreRules).toHaveBeenCalledWith();
});

it("adds a directory ignore rule and no longer offers raw skill ids as subjects", async () => {
  const createIgnoreRule = vi.fn(async (draft: Parameters<LibraryHealthOperations["createIgnoreRule"]>[0]) => ({
    id: "rule-new",
    subject: draft.subject,
    reason: draft.reason,
    created_at: "2026-09-06T08:00:00Z",
    defer_until: draft.deferUntil,
  }));
  await renderLibrary(healthFacade({ createIgnoreRule }));
  expect(await screen.findByText("暂无忽略规则。")).toBeVisible();

  // AR-016：用户无法理解的“精确 Skill/精确待处理”自由输入不再提供。
  const subjectSelect = screen.getByLabelText("主体类型");
  const options = Array.from(subjectSelect.querySelectorAll("option")).map(
    (option) => option.value,
  );
  expect(options).toEqual(["exact_path"]);

  fireEvent.change(screen.getByLabelText("要忽略的目录路径"), { target: { value: "C:/temp/drafts" } });
  fireEvent.change(screen.getByLabelText("理由"), { target: { value: "草稿目录不参与检查" } });
  await click(screen.getByRole("button", { name: "添加规则" }));

  expect(createIgnoreRule).toHaveBeenCalledWith({
    subject: { type: "exact_path", value: "C:/temp/drafts" },
    reason: "草稿目录不参与检查",
    deferUntil: null,
  });
  expect(await screen.findByText("C:/temp/drafts")).toBeVisible();
});

it("explains how the ignore, health check and repair workflow fit together", async () => {
  await renderLibrary(healthFacade());

  // AR-016：整合说明——检查发现问题、修复预览执行、忽略只针对路径。
  expect(screen.getByText(/健康检查发现问题/)).toBeVisible();
  expect(screen.getByText(/修复预览/)).toBeVisible();
});

it("blocks adding an ignore rule without a reason and reports it", async () => {
  const createIgnoreRule = vi.fn(async () => {
    throw new Error("create_ignore_rule should not run");
  });
  await renderLibrary(healthFacade({ createIgnoreRule }));
  expect(await screen.findByText("暂无忽略规则。")).toBeVisible();

  fireEvent.change(screen.getByLabelText("要忽略的目录路径"), { target: { value: "C:/temp" } });
  await click(screen.getByRole("button", { name: "添加规则" }));

  expect(createIgnoreRule).not.toHaveBeenCalled();
  expect(await screen.findByText("请填写忽略理由。")).toBeVisible();
});

it("removes an ignore rule only after an explicit confirmation", async () => {
  const removeIgnoreRule = vi.fn(async () => undefined);
  await renderLibrary(healthFacade({ listIgnoreRules: async () => [pathRule], removeIgnoreRule }));
  expect(await screen.findByText("C:/SkillHub/library/drafts")).toBeVisible();

  await click(screen.getByRole("button", { name: "移除" }));
  expect(removeIgnoreRule).not.toHaveBeenCalled();
  expect(
    await screen.findByText("移除后C:/SkillHub/library/drafts将重新参与健康检查。"),
  ).toBeVisible();

  await click(await screen.findByRole("button", { name: "确认移除" }));
  expect(removeIgnoreRule).toHaveBeenCalledWith("rule-1");
  await act(async () => {});
  expect(screen.queryByText("C:/SkillHub/library/drafts")).toBeNull();
});

it("prepares a repair preview from a health finding without committing", async () => {
  const prepareRepair = vi.fn(async () => plan);
  const commitRepair = vi.fn(async () => {
    throw new Error("commit_repair should not run yet");
  });
  await renderLibrary(
    healthFacade({
      runHealthCheck: async () =>
        report([{ code: "orphan_metadata", severity: "warning", repair: "remove_orphan_metadata" }]),
      prepareRepair,
      commitRepair,
    }),
  );

  await click(screen.getByRole("button", { name: "运行健康检查" }));
  await click(await screen.findByRole("button", { name: "修复预览" }));

  expect(prepareRepair).toHaveBeenCalledWith("op-health-1", 0);
  const detail = await screen.findByRole("region", { name: "修复计划" });
  expect(detail).toBeVisible();
  expect(detail).toHaveTextContent("orphan_metadata");
  expect(detail).toHaveTextContent("警告");
  expect(detail).toHaveTextContent("remove_orphan_metadata");
  expect(commitRepair).not.toHaveBeenCalled();
});

it("commits the repair only after the explicit execute action", async () => {
  const commitRepair = vi.fn(async () => ({
    operation_id: "op-repair-1",
    phase: "committed" as const,
    message_code: "health.repair_committed",
    error_code: null,
  }));
  await renderLibrary(
    healthFacade({
      runHealthCheck: async () =>
        report([{ code: "orphan_metadata", severity: "warning", repair: "remove_orphan_metadata" }]),
      prepareRepair: async () => plan,
      commitRepair,
    }),
  );

  await click(screen.getByRole("button", { name: "运行健康检查" }));
  await click(await screen.findByRole("button", { name: "修复预览" }));
  expect(commitRepair).not.toHaveBeenCalled();

  await click(await screen.findByRole("button", { name: "执行修复" }));

  expect(commitRepair).toHaveBeenCalledWith("op-repair-1");
  expect(await screen.findByText("修复已执行。")).toBeVisible();
  expect(screen.queryByRole("region", { name: "修复计划" })).toBeNull();
});

it("closes the repair preview without writing anything on cancel", async () => {
  const commitRepair = vi.fn(async () => {
    throw new Error("commit_repair should not run");
  });
  await renderLibrary(
    healthFacade({
      runHealthCheck: async () =>
        report([{ code: "orphan_metadata", severity: "warning", repair: "remove_orphan_metadata" }]),
      prepareRepair: async () => plan,
      commitRepair,
    }),
  );

  await click(screen.getByRole("button", { name: "运行健康检查" }));
  await click(await screen.findByRole("button", { name: "修复预览" }));
  await click(await screen.findByRole("button", { name: "取消" }));

  expect(commitRepair).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "修复计划" })).toBeNull();
});

it("hides the repair preview entry when a finding has no repair action", async () => {
  await renderLibrary(
    healthFacade({
      runHealthCheck: async () =>
        report([
          { code: "mystery", severity: "info", repair: null },
        ] as unknown as HealthReport["findings"]),
    }),
  );

  await click(screen.getByRole("button", { name: "运行健康检查" }));

  expect(await screen.findByText("mystery")).toBeVisible();
  expect(screen.queryByRole("button", { name: "修复预览" })).toBeNull();
});
