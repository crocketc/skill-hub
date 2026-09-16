import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { beginBackgroundScan, resetBackgroundScan } from "../features/bootstrap/backgroundScan";
import { createSkillHubI18n } from "../i18n";
import { createOperationTracker } from "../platform/operationTracker";
import "../styles/base.css";
import { TaskStatusIndicator } from "./TaskStatusIndicator";

async function renderIndicator(tracker = createOperationTracker()) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const view = render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <TaskStatusIndicator tracker={tracker} />
      </MemoryRouter>
    </I18nextProvider>,
  );
  return { i18n, tracker, view };
}

/** 从注入的样式表中取回指定选择器的规则（精确匹配逗号分隔的任一段）。 */
function ruleFor(selector: string): CSSStyleRule | undefined {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (
        rule instanceof CSSStyleRule &&
        rule.selectorText
          ?.split(",")
          .map((part) => part.trim())
          .includes(selector)
      ) {
        return rule;
      }
    }
  }
  return undefined;
}

afterEach(() => {
  resetBackgroundScan();
});

describe("TaskStatusIndicator 在途投影", () => {
  it("renders nothing at all when no operation is in flight", async () => {
    const { view } = await renderIndicator();

    expect(view.container.querySelector(".sh-task-summary")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("surfaces a batch import's real progress in the topbar summary", async () => {
    const tracker = createOperationTracker();
    const operationId = tracker.begin({ kind: "import", label: "批量导入 Skill", total: 42 });
    tracker.progress(operationId, 1, 42);
    await renderIndicator(tracker);

    const trigger = screen.getByRole("button", { name: "批量导入 Skill：进行中（1/42）" });
    expect(trigger).toBeVisible();
    expect(screen.getByText("批量导入 Skill")).toBeVisible();
  });

  it("keeps the topbar summary at a fixed 360px width", async () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "import", label: "占位", total: 1 });
    tracker.start(id);
    const { view } = await renderIndicator(tracker);

    expect(view.container.querySelector(".sh-task-summary")).not.toBeNull();
    const rule = ruleFor(".sh-task-summary");
    expect(rule, ".sh-task-summary is defined in base.css").toBeDefined();
    expect(rule!.style.getPropertyValue("width")).toBe("360px");
    expect(rule!.style.getPropertyValue("flex")).toBe("0 0 auto");
  });

  it("shows an item counter for multiple in-flight operations and pages one item per popover page", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    const deploy = tracker.begin({ kind: "deploy", label: "添加到 Agent", total: 2 });
    tracker.progress(deploy, 1, 2);
    const removal = tracker.begin({ kind: "remove", label: "从 Agent 移除", total: 1 });
    tracker.start(removal);
    const analysis = tracker.begin({ kind: "ai_analysis", label: "AI 分析", total: 0 });
    tracker.start(analysis);
    await renderIndicator(tracker);

    // 多任务时顶栏摘要带 1/3 计数，当前项=最新开始的在途任务。
    expect(screen.getByText("1/3")).toBeVisible();
    expect(screen.getByText("AI 分析")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /AI 分析/ }));
    const popover = screen.getByRole("dialog", { name: "后台任务" });
    expect(within(popover).getByText("AI 分析")).toBeVisible();
    expect(within(popover).queryByText("从 Agent 移除")).toBeNull();

    // 前后翻页：一项一页，位置文案同步；首末两端按钮禁用。
    expect(within(popover).getByRole("button", { name: "上一项" })).toBeDisabled();
    await user.click(within(popover).getByRole("button", { name: "下一项" }));
    expect(within(popover).getByText("从 Agent 移除")).toBeVisible();
    expect(within(popover).queryByText("AI 分析")).toBeNull();
    expect(within(popover).getByText("第 2 项，共 3 项")).toBeVisible();

    await user.click(within(popover).getByRole("button", { name: "下一项" }));
    expect(within(popover).getByText("添加到 Agent")).toBeVisible();
    expect(within(popover).getByRole("button", { name: "下一项" })).toBeDisabled();

    await user.click(within(popover).getByRole("button", { name: "上一项" }));
    expect(within(popover).getByText("从 Agent 移除")).toBeVisible();
  });

  it("keeps the popover list scrollable when the details overflow", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "import", label: "批量导入 Skill", total: 3 });
    tracker.start(id);
    await renderIndicator(tracker);

    await user.click(screen.getByRole("button", { name: /批量导入 Skill/ }));
    const rule = ruleFor(".sh-task-popover__list");
    expect(rule, ".sh-task-popover__list is defined in base.css").toBeDefined();
    expect(rule!.style.getPropertyValue("overflow-y")).toBe("auto");
    expect(rule!.style.getPropertyValue("max-height")).not.toBe("");
  });

  it("closes the popover on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "import", label: "批量导入 Skill", total: 2 });
    tracker.start(id);
    await renderIndicator(tracker);

    const trigger = screen.getByRole("button", { name: /批量导入 Skill/ });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "后台任务" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "后台任务" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes the popover on outside click without yanking focus back", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "import", label: "批量导入 Skill", total: 2 });
    tracker.start(id);
    const { view } = await renderIndicator(tracker);

    const trigger = screen.getByRole("button", { name: /批量导入 Skill/ });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "后台任务" })).toBeVisible();

    // 指针点击外部：只收起浮层；焦点跟随用户点击，不被抢回触发器。
    await user.click(view.container);
    expect(screen.queryByRole("dialog", { name: "后台任务" })).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("deep links the in-flight item to its persisted operation record", async () => {
    const user = userEvent.setup();
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "deploy", label: "添加到 Agent", total: 1 });
    tracker.attach(id, { operationId: "op-11" });
    await renderIndicator(tracker);

    await user.click(screen.getByRole("button", { name: /添加到 Agent/ }));
    expect(screen.getByRole("link", { name: "查看操作记录" })).toHaveAttribute(
      "href",
      "/operations/op-11",
    );
  });

  it("surfaces needs_user operations as awaiting user action", async () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "restore", label: "恢复备份", total: 1 });
    tracker.start(id);
    tracker.needsUser(id);
    await renderIndicator(tracker);

    expect(screen.getByRole("button", { name: "恢复备份：需人工确认" })).toBeVisible();
  });

  it("surfaces unknown progress honestly when the total is not known", async () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "ai_check", label: "AI 检查", total: 0 });
    tracker.start(id);
    tracker.progress(id, 1);
    await renderIndicator(tracker);

    expect(screen.getByRole("button", { name: "AI 检查：进行中（进度未知）" })).toBeVisible();
  });

  it("keeps the handed-off initialization scan visible as an in-flight task", async () => {
    await renderIndicator();

    act(() => {
      beginBackgroundScan(new Promise(() => undefined), ["scope-1"]);
    });

    expect(screen.getByRole("button", { name: "初始化只读扫描" })).toBeVisible();
  });

  it("hides completed operations from the summary once their notification carries the result", async () => {
    const tracker = createOperationTracker();
    const id = tracker.begin({ kind: "import", label: "批量导入 Skill", total: 1 });
    tracker.start(id);
    const { tracker: renderedTracker } = await renderIndicator(tracker);
    expect(screen.getByRole("button", { name: /批量导入 Skill/ })).toBeVisible();

    act(() => {
      renderedTracker.complete(id, { succeeded: 1, failed: 0, skipped: 0 });
    });
    expect(screen.queryByRole("button", { name: /批量导入 Skill/ })).toBeNull();
  });
});
