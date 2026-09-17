import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import type { UpstreamCheckResult } from "../../api/bindings";
import { createOperationTracker, type OperationTracker } from "../../platform/operationTracker";
import { AppNotificationsProvider } from "../../ui/notifications";
import { SourceUpdatePanel, type SourceUpdateFacade } from "./SourceUpdatePanel";

const result: UpstreamCheckResult = {
  skill_id: "s1",
  state: "update_available",
  local_version: "v3",
  upstream_version: "v4",
};

function makeFacade(overrides: Partial<SourceUpdateFacade> = {}): SourceUpdateFacade {
  return {
    checkSourceUpdate: async () => result,
    applySourceUpdate: async () => ({
      skill_id: "s1",
      decision: "take_upstream",
      new_version: "v4",
      deployments_need_reconciliation: false,
    }),
    ...overrides,
  };
}

async function renderPanel(facade: SourceUpdateFacade) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <SourceUpdatePanel facade={facade} skillId="s1" />
    </I18nextProvider>,
  );
}

async function renderPanelWithBridge(
  facade: SourceUpdateFacade,
  tracker: OperationTracker = createOperationTracker(),
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const view = render(
    <I18nextProvider i18n={i18n}>
      <AppNotificationsProvider>
        <SourceUpdatePanel facade={facade} skillId="s1" tracker={tracker} />
      </AppNotificationsProvider>
    </I18nextProvider>,
  );
  return { ...view, tracker };
}

it("reports an up-to-date source honestly", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({ checkSourceUpdate: async () => ({ ...result, state: "up_to_date" }) }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText(/已是最新/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "采用上游版本" })).not.toBeInTheDocument();
});

it("offers explicit decisions when an update is available", async () => {
  const user = userEvent.setup();
  const applySourceUpdate = vi.fn(async () => ({
    skill_id: "s1",
    decision: "take_upstream" as const,
    new_version: "v4",
    deployments_need_reconciliation: false,
  }));
  await renderPanel(makeFacade({ applySourceUpdate }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText(/本地 v3/)).toBeVisible();
  expect(screen.getByText(/上游 v4/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "采用上游版本" }));
  await waitFor(() => expect(applySourceUpdate).toHaveBeenCalledWith("s1", "take_upstream"));
  expect(await screen.findByText(/已采用上游版本/)).toBeVisible();
});

it("warns about local changes and refuses silent overwrite via take-upstream", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({ checkSourceUpdate: async () => ({ ...result, state: "update_available_with_local_changes" }) }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText(/本地有修改/)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "采用上游版本" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/覆盖这些修改/)).toBeVisible();
});

it("states honestly when a skill has no upstream to check", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({ checkSourceUpdate: async () => ({ ...result, state: "no_upstream" }) }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText(/没有可检查更新的上游来源/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "采用上游版本" })).not.toBeInTheDocument();
});

it("renders a structured native error readably instead of [object Object]", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    applySourceUpdate: async () => {
      throw {
        code: "operation.conflict",
        severity: "error",
        params: { reason: "no_upstream_source" },
        actions: [],
      };
    },
  }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toContain("[object Object]");
  expect(alert.textContent).toContain("operation.conflict");
});

it("states unavailability instead of pretending a check succeeded", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({ checkSourceUpdate: async () => ({ ...result, state: "source_unavailable" }) }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText(/来源暂不可用/)).toBeVisible();
});

it("surfaces the reconciliation note when deployments need it", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    applySourceUpdate: async () => ({
      skill_id: "s1",
      decision: "take_upstream",
      new_version: "v4",
      deployments_need_reconciliation: true,
    }),
  }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  expect(await screen.findByText(/重新同步/)).toBeVisible();
});

it("keeps applying an update in the tracked task list until it finishes", async () => {
  const user = userEvent.setup();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { tracker } = await renderPanelWithBridge(makeFacade({
    applySourceUpdate: async () => {
      await gate;
      return {
        skill_id: "s1",
        decision: "take_upstream",
        new_version: "v4",
        deployments_need_reconciliation: false,
      };
    },
  }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));

  // 应用上游更新会重写受管副本：属于长流程，必须占用在途顶栏。
  await waitFor(() => expect(tracker.getSnapshot()).toHaveLength(1));
  expect(tracker.getSnapshot()[0]).toMatchObject({
    kind: "apply_source_update",
    label: "应用来源更新",
    status: "running",
  });

  release();
  await waitFor(() => expect(tracker.getSnapshot()[0].status).toBe("success"));
  expect(await screen.findByText(/已采用上游版本/)).toBeVisible();
});

it("reports an apply failure with the same readable reason as the page", async () => {
  const user = userEvent.setup();
  await renderPanelWithBridge(makeFacade({
    applySourceUpdate: async () => {
      throw {
        code: "operation.conflict",
        severity: "error",
        params: { reason: "no_upstream_source" },
        actions: [],
      };
    },
  }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));

  const notice = await screen.findByTestId("notice-danger");
  expect(notice).toHaveTextContent("来源更新未能应用");
  const detail = notice.querySelector(".sh-notification__detail");
  expect(detail?.textContent).not.toContain("[object Object]");
  expect(detail?.textContent).toContain("没有可采用的 upstream 来源");
  const inlineAlert = (await screen.findAllByRole("alert")).find(
    (node) => node.tagName === "P",
  );
  expect(inlineAlert?.textContent).toContain("没有可采用的 upstream 来源");
});
