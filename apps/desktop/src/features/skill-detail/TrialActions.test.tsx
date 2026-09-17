import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { operationTracker } from "../../platform/operationTracker";
import { AppNotificationsProvider } from "../../ui/notifications";
import { TrialActions } from "./TrialActions";
import { createMockSkillDetailFacade, trialDetailFixture } from "./testFixtures";

async function renderTrial(facade = createMockSkillDetailFacade()) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <TrialActions facade={facade} skillId="skill-pdf" summary={trialDetailFixture().summary} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return facade;
}

async function renderTrialWithBridge(facade = createMockSkillDetailFacade()) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <AppNotificationsProvider>
          <TrialActions facade={facade} skillId="skill-pdf" summary={trialDetailFixture().summary} />
        </AppNotificationsProvider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return facade;
}

describe("TrialActions", () => {
  it("converts trial by removing only the trial date", async () => {
    const facade = await renderTrial();
    fireEvent.click(screen.getByRole("button", { name: "正式纳入管理" }));
    await waitFor(() => expect(facade.calls.trials).toEqual([{ due: null, skillId: "skill-pdf" }]));
    expect(facade.calls.intents).toEqual([]);
  });

  it("hands abandon-trial to the later removal workflow without claiming deletion", async () => {
    const facade = await renderTrial();
    fireEvent.click(screen.getByRole("button", { name: "放弃试用" }));
    await waitFor(() => expect(facade.calls.intents).toContainEqual({ skillId: "skill-pdf", type: "abandon_trial" }));
    expect(screen.queryByText("已删除")).not.toBeInTheDocument();
  });

  it("extends the review date and preserves the chosen date when saving fails", async () => {
    const facade = createMockSkillDetailFacade({ failTrialSave: true });
    await renderTrial(facade);
    fireEvent.click(screen.getByRole("button", { name: "延长试用" }));
    fireEvent.change(screen.getByLabelText("复核日期"), { target: { value: "2026-09-02" } });
    fireEvent.click(screen.getByRole("button", { name: "保存复核日期" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("未能保存试用日期");
    expect(screen.getByLabelText("复核日期")).toHaveValue("2026-09-02");
    expect(facade.calls.trials).toEqual([{ due: "2026-09-02", skillId: "skill-pdf" }]);
  });

  it("cancels a trial-date edit without sending a mutation", async () => {
    const facade = await renderTrial();
    fireEvent.click(screen.getByRole("button", { name: "延长试用" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(facade.calls.trials).toEqual([]);
  });
});

describe("TrialActions 与统一执行桥", () => {
  it("reports the converted trial as one success notice without a tracked task", async () => {
    const facade = await renderTrialWithBridge();

    fireEvent.click(screen.getByRole("button", { name: "正式纳入管理" }));

    await waitFor(() => expect(facade.calls.trials).toEqual([{ due: null, skillId: "skill-pdf" }]));
    // 单次同步写入：不占用在途顶栏。
    expect(operationTracker.getSnapshot()).toEqual([]);
    const notice = await screen.findByTestId("notice-success");
    expect(notice).toHaveTextContent("已移除试用日期，此 Skill 仍由 SkillHub 管理。");
  });

  it("reports a failed review-date save as a danger notice and keeps the inline reason", async () => {
    const facade = createMockSkillDetailFacade({ failTrialSave: true });
    await renderTrialWithBridge(facade);

    fireEvent.click(screen.getByRole("button", { name: "延长试用" }));
    fireEvent.change(screen.getByLabelText("复核日期"), { target: { value: "2026-09-02" } });
    fireEvent.click(screen.getByRole("button", { name: "保存复核日期" }));

    const notice = await screen.findByTestId("notice-danger");
    expect(notice).toHaveTextContent("未能保存试用日期。");
    expect(notice).toHaveTextContent("trial save failed");
    const inlineAlert = (await screen.findAllByRole("alert")).find(
      (node) => node.tagName === "P",
    );
    expect(inlineAlert).toHaveTextContent("未能保存试用日期");
    expect(screen.getByLabelText("复核日期")).toHaveValue("2026-09-02");
  });

  it("reports a rejected abandon-trial intent instead of failing silently", async () => {
    const facade = createMockSkillDetailFacade();
    facade.emitIntent = async () => {
      throw new Error("intent failed");
    };
    await renderTrialWithBridge(facade);

    fireEvent.click(screen.getByRole("button", { name: "放弃试用" }));

    const notice = await screen.findByTestId("notice-danger");
    expect(notice).toHaveTextContent("放弃试用未能完成");
    expect(notice).toHaveTextContent("intent failed");
    const inlineAlert = (await screen.findAllByRole("alert")).find(
      (node) => node.tagName === "P",
    );
    expect(inlineAlert).toHaveTextContent("未能进入后续移除流程。");
  });
});
