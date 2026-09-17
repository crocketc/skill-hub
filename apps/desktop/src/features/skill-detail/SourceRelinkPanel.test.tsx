import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import { operationTracker } from "../../platform/operationTracker";
import { AppNotificationsProvider } from "../../ui/notifications";
import { SourceRelinkPanel, type SourceRelinkFacade } from "./SourceRelinkPanel";

function makeFacade(overrides: Partial<SourceRelinkFacade> = {}): SourceRelinkFacade {
  return {
    relinkSource: async () => ({ messageCode: "source.relinked" }),
    ...overrides,
  };
}

async function renderPanel(facade: SourceRelinkFacade) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <SourceRelinkPanel facade={facade} skillId="s1" />
    </I18nextProvider>,
  );
}

async function renderPanelWithBridge(facade: SourceRelinkFacade) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <AppNotificationsProvider>
        <SourceRelinkPanel facade={facade} skillId="s1" />
      </AppNotificationsProvider>
    </I18nextProvider>,
  );
}

it("submits a parsed source input and reports success", async () => {
  const user = userEvent.setup();
  const relinkSource = vi.fn(async () => ({ messageCode: "source.relinked" }));
  await renderPanel(makeFacade({ relinkSource }));

  await user.type(screen.getByLabelText("新的来源"), "https://github.com/o/r");
  await user.click(screen.getByRole("button", { name: "重新关联" }));

  await waitFor(() => expect(relinkSource).toHaveBeenCalledWith("s1", "https://github.com/o/r"));
  expect(await screen.findByRole("status")).toHaveTextContent("已重新关联来源");
});

it("shows a structured error instead of pretending success", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({ relinkSource: async () => { throw new Error("来源不可用"); } }));

  await user.type(screen.getByLabelText("新的来源"), "C:/new/path");
  await user.click(screen.getByRole("button", { name: "重新关联" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("来源不可用");
});

it("describes structured native errors in readable copy instead of [object Object]", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    relinkSource: async () => {
      throw { code: "llm.not_configured", severity: "error", params: {}, actions: [] };
    },
  }));

  await user.type(screen.getByLabelText("新的来源"), "https://github.com/o/r");
  await user.click(screen.getByRole("button", { name: "重新关联" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("尚未配置可用的 LLM 供应商，请先添加并启用供应商。");
  expect(alert.textContent).not.toContain("[object Object]");
});

it("does not submit an empty source", async () => {
  const user = userEvent.setup();
  const relinkSource = vi.fn(async () => ({ messageCode: "source.relinked" }));
  await renderPanel(makeFacade({ relinkSource }));

  await user.click(screen.getByRole("button", { name: "重新关联" }));
  expect(relinkSource).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "重新关联" })).toBeDisabled();
});

it("reports a successful re-link as one notice without a tracked task", async () => {
  const user = userEvent.setup();
  await renderPanelWithBridge(makeFacade());

  await user.type(screen.getByLabelText("新的来源"), "https://github.com/o/r");
  await user.click(screen.getByRole("button", { name: "重新关联" }));

  // 重新关联是单次写入命令：不给顶栏伪造一个可取消的后台阶段。
  expect(operationTracker.getSnapshot()).toEqual([]);
  const notice = await screen.findByTestId("notice-success");
  expect(notice).toHaveTextContent("已重新关联来源");
});

it("reports a structured re-link failure readably instead of [object Object]", async () => {
  const user = userEvent.setup();
  await renderPanelWithBridge(makeFacade({
    relinkSource: async () => {
      throw { code: "llm.not_configured", severity: "error", params: {}, actions: [] };
    },
  }));

  await user.type(screen.getByLabelText("新的来源"), "https://github.com/o/r");
  await user.click(screen.getByRole("button", { name: "重新关联" }));

  const notice = await screen.findByTestId("notice-danger");
  expect(notice).toHaveTextContent("重新关联未能完成");
  const detail = notice.querySelector(".sh-notification__detail");
  expect(detail?.textContent).not.toContain("[object Object]");
  expect(detail?.textContent).toContain("尚未配置可用的 LLM 供应商");
  // 页面局部提示保留结构化错误描述，两处不互相矛盾。
  const inlineAlert = (await screen.findAllByRole("alert")).find(
    (node) => node.tagName === "P",
  );
  expect(inlineAlert).toHaveTextContent("尚未配置可用的 LLM 供应商");
});
