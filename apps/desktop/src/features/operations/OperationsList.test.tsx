import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker } from "../../platform/operationTracker";
import { OperationsList } from "./OperationsList";
import type { RecentOperationsReader } from "./api";

const recent: RecentOperationsReader = {
  async listRecentOperations() {
    return [
      {
        operation_id: "op-1",
        kind: "import",
        state: "committed",
        phase: "committed",
        error_code: null,
        created_at: "2026-09-06T08:00:00Z",
      },
      {
        operation_id: "op-2",
        kind: "deployment",
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

it("lists recent native operations with links to their detail pages", async () => {
  await renderList();

  const rows = await screen.findAllByRole("listitem");
  expect(rows.length).toBeGreaterThanOrEqual(2);
  const detail = screen.getByRole("link", { name: "import" });
  expect(detail.getAttribute("href")).toBe("/operations/op-1");
  const failedDetail = screen.getByRole("link", { name: "deployment" });
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
  expect(within(entries[1]).getByText(/错误码：deployment\.target_conflict/)).toBeInTheDocument();

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
