import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker } from "../../platform/operationTracker";
import { OperationsList } from "./OperationsList";
import { OperationsRecordsPage } from "./OperationsRecordsPage";
import type { RecentOperationsReader } from "./api";

const recent: RecentOperationsReader = {
  async listRecentOperations() {
    return [
      {
        operation_id: "op-1",
        kind: "import_skill",
        object_name: "示例包",
        state: "committed",
        phase: "committed",
        error_code: null,
        created_at: "2026-09-06T08:00:00Z",
      },
      {
        operation_id: "op-2",
        kind: "deploy_skill",
        object_name: "PDF 抽取器",
        state: "failed",
        phase: "needs_recovery",
        error_code: "deployment.target_conflict",
        created_at: "2026-09-06T07:00:00Z",
      },
    ];
  },
};

async function renderList(
  reader: RecentOperationsReader | null = recent,
  tracker?: ReturnType<typeof createOperationTracker>,
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <OperationsList recent={reader ?? undefined} tracker={tracker} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

// T3-C「每路由唯一 h1」（任务 10 h1 sweep）：操作记录页自持 route-level h1。
it("keeps a single page-level h1 for the operations records outline", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/operations"]}>
        <Routes>
          <Route path="/operations" element={<OperationsRecordsPage recent={recent} />} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );

  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { level: 1, name: "Operation records" })).toBeVisible();
});

it("lists recent native operations with links to their detail pages", async () => {
  await renderList();

  const rows = await screen.findAllByRole("listitem");
  expect(rows.length).toBeGreaterThanOrEqual(2);
  const detail = screen.getByRole("link", { name: "导入技能：示例包" });
  expect(detail.getAttribute("href")).toBe("/operations/op-1");
  const failedDetail = screen.getByRole("link", { name: "部署技能：PDF 抽取器" });
  expect(failedDetail.getAttribute("href")).toBe("/operations/op-2");
  expect(screen.getByText(/deployment\.target_conflict/)).toBeVisible();
});

it("renders a structured timeline whose entries expose phase, error code, and localized time", async () => {
  await renderList();

  const timeline = await screen.findByRole("list", { name: "操作时间线" });
  const entries = within(timeline).getAllByRole("listitem");
  expect(entries.length).toBe(2);

  // 阶段语义：不再展示原始 state 字符串，而是可读的阶段徽标（图标＋文字）。
  expect(within(entries[0]).getByText("已提交")).toBeInTheDocument();
  expect(within(entries[1]).getByText("需要恢复")).toBeInTheDocument();
  // DEV-99：错误码不独立成值——映射为可读失败说明，码值只作括注。
  expect(within(entries[1]).getByText(/操作未能完成（deployment\.target_conflict）/)).toBeInTheDocument();

  // 时间必须经 Intl.DateTimeFormat 本地化，原始 ISO 只保留在 dateTime 属性里。
  const times = within(timeline).getAllByRole("time");
  expect(times[0]).toHaveAttribute("dateTime", "2026-09-06T08:00:00Z");
  expect(times[0]).toHaveTextContent(/2026年9月6日/);
  expect(screen.queryByText("2026-09-06T08:00:00Z")).not.toBeInTheDocument();
});

it("shows session-tracked background operations in their own section", async () => {
  const tracker = createOperationTracker();
  const id = tracker.begin({ kind: "import", label: "批量导入 Skill", total: 2 });
  tracker.progress(id, 1, 2);
  await renderList(recent, tracker);

  expect(screen.getByText("批量导入 Skill")).toBeVisible();
  expect(screen.getByText(/1\/2/)).toBeVisible();
});

it("shows an honest empty state when there are no operations at all", async () => {
  await renderList({
    async listRecentOperations() {
      return [];
    },
  });

  expect(await screen.findByText(/尚未有任何操作记录/)).toBeVisible();
});

it("reports read failures instead of pretending an empty history", async () => {
  await renderList({
    async listRecentOperations() {
      throw new Error("native unavailable");
    },
  });

  expect(await screen.findByRole("alert")).toBeVisible();
});

// DEV-94：kind 是内部技术名（import_skill 等），不得裸奔进界面——标题与
// 详情链接都要用本地化操作名；未知 kind 才回退原文（加映射前的兜底）。
it("localizes known operation kinds as row titles and detail link text", async () => {
  await renderList({
    async listRecentOperations() {
      return [
        {
          operation_id: "op-1",
          kind: "import_skill",
          state: "committed",
          phase: "committed",
          error_code: null,
          created_at: "2026-09-06T08:00:00Z",
        },
        {
          operation_id: "op-2",
          kind: "deploy_skill",
          state: "failed",
          phase: "needs_recovery",
          error_code: "deployment.target_conflict",
          created_at: "2026-09-06T07:00:00Z",
        },
      ];
    },
  });

  const imported = await screen.findByRole("link", { name: "导入技能" });
  expect(imported.getAttribute("href")).toBe("/operations/op-1");
  expect(screen.getByRole("link", { name: "部署技能" }).getAttribute("href")).toBe(
    "/operations/op-2",
  );
  expect(screen.queryByRole("link", { name: "import_skill" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "deploy_skill" })).not.toBeInTheDocument();
});

// DEV-94：快照携带 object_name 时，标题链接必须包含对象名——只有「导入
// 技术」的裸 kind 无法区分多条导入，用户需要知道操作针对哪个 Skill。
it("includes the snapshot object name in the entry title when present", async () => {
  await renderList({
    async listRecentOperations() {
      return [
        {
          operation_id: "op-1",
          kind: "import_skill",
          state: "completed",
          phase: "committed",
          error_code: null,
          created_at: "2026-09-06T08:00:00Z",
          object_name: "Notes",
        },
      ];
    },
  });

  const imported = await screen.findByRole("link", { name: "导入技能：Notes" });
  expect(imported.getAttribute("href")).toBe("/operations/op-1");
});

// DEV-94：后端 created_at 是 epoch 秒字符串，按 ISO 解析失败后不得把原始
// 数字串回显给用户。
it("formats epoch-second timestamps instead of echoing the raw value", async () => {
  await renderList({
    async listRecentOperations() {
      return [
        {
          operation_id: "op-1",
          kind: "import_skill",
          state: "committed",
          phase: "committed",
          error_code: null,
          created_at: "1789890340",
        },
      ];
    },
  });

  const time = await screen.findByRole("time");
  expect(time).toHaveAttribute("dateTime", "1789890340");
  expect(time.textContent).toMatch(/^\d{4}年/);
  expect(screen.queryByText("1789890340")).not.toBeInTheDocument();
});

// DEV-94：部署类操作快照已携带 targets 结果明细（前端此前丢弃）。有条目
// 时渲染「成功 N、失败 M」摘要，失败目标给出路径，不再只有一行技术名。
it("summarizes per-target results when the snapshot carries them", async () => {
  await renderList({
    async listRecentOperations() {
      return [
        {
          operation_id: "op-1",
          kind: "deploy_skill",
          state: "partial",
          phase: "committed",
          error_code: null,
          created_at: "2026-09-06T08:00:00Z",
          targets: [
            { physical_target_id: "t1", path: "C:\\agents\\codex\\skills\\tdd", error_code: null },
            { physical_target_id: "t2", path: "C:\\agents\\pi\\skills\\tdd", error_code: "deployment.target_conflict" },
          ],
        },
      ];
    },
  });

  const entry = await screen.findByRole("listitem");
  expect(within(entry).getByText("成功 1、失败 1")).toBeVisible();
  expect(within(entry).getByText(/C:\\agents\\pi\\skills\\tdd/)).toBeVisible();
});
