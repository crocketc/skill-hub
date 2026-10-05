import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import { operationTracker } from "../../platform/operationTracker";
import { AppNotificationsProvider } from "../../ui/notifications";
import type { SourceRelinkInput } from "./api";
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

/** 默认选择「本地目录」类型并输入。 */
async function submitSource(
  user: ReturnType<typeof userEvent.setup>,
  kindLabel: string | null,
  value: string,
) {
  if (kindLabel) {
    await user.click(screen.getByRole("radio", { name: kindLabel }));
  }
  await user.type(screen.getByRole("textbox", { name: /新的来源/ }), value);
  await user.click(screen.getByRole("button", { name: "重新关联" }));
}

it("submits a local directory without guessing a protocol", async () => {
  const user = userEvent.setup();
  const relinkSource = vi.fn(async () => ({ messageCode: "source.relinked" }));
  await renderPanel(makeFacade({ relinkSource }));

  await submitSource(user, null, "C:/Skills/pdf-reader");

  await waitFor(() =>
    expect(relinkSource).toHaveBeenCalledWith("s1", {
      kind: "local",
      value: "C:/Skills/pdf-reader",
    } satisfies SourceRelinkInput),
  );
  expect(await screen.findByRole("status")).toHaveTextContent("已重新关联来源");
});

it("requires an explicit https choice before submitting an https address", async () => {
  const user = userEvent.setup();
  const relinkSource = vi.fn(async () => ({ messageCode: "source.relinked" }));
  await renderPanel(makeFacade({ relinkSource }));

  await submitSource(user, "HTTPS 地址", "https://github.com/o/r");

  await waitFor(() =>
    expect(relinkSource).toHaveBeenCalledWith("s1", {
      kind: "https",
      value: "https://github.com/o/r",
    } satisfies SourceRelinkInput),
  );
  expect(await screen.findByRole("status")).toHaveTextContent("已重新关联来源");
});

it("requires an explicit git choice before submitting a git url", async () => {
  const user = userEvent.setup();
  const relinkSource = vi.fn(async () => ({ messageCode: "source.relinked" }));
  await renderPanel(makeFacade({ relinkSource }));

  await submitSource(user, "Git 仓库", "git@github.com:o/r.git");

  await waitFor(() =>
    expect(relinkSource).toHaveBeenCalledWith("s1", {
      kind: "git",
      value: "git@github.com:o/r.git",
    } satisfies SourceRelinkInput),
  );
});

it("refuses to submit an https address while the local type is selected", async () => {
  const user = userEvent.setup();
  const relinkSource = vi.fn(async () => ({ messageCode: "source.relinked" }));
  await renderPanel(makeFacade({ relinkSource }));

  await submitSource(user, null, "https://github.com/o/r");

  // 类型与内容不符时不允许提交，更不按自由文本猜测协议。
  expect(relinkSource).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(/https:\/\/开头/);
});

it("keeps the entered source facts when the backend rejects the relink", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    relinkSource: async () => {
      throw new Error("来源目录不存在");
    },
  }));

  await submitSource(user, null, "C:/Skills/gone");

  expect(await screen.findByRole("alert")).toHaveTextContent("来源目录不存在");
  expect(screen.getByRole("textbox", { name: /新的来源/ })).toHaveValue("C:/Skills/gone");
});

it("shows a structured error instead of pretending success", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({ relinkSource: async () => { throw new Error("来源不可用"); } }));

  await submitSource(user, null, "C:/new/path");

  expect(await screen.findByRole("alert")).toHaveTextContent("来源不可用");
});

it("describes structured native errors in readable copy instead of [object Object]", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    relinkSource: async () => {
      throw { code: "llm.not_configured", severity: "error", params: {}, actions: [] };
    },
  }));

  await submitSource(user, null, "C:/new/path");

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

  await submitSource(user, "HTTPS 地址", "https://github.com/o/r");

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

  await submitSource(user, null, "C:/new/path");

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
