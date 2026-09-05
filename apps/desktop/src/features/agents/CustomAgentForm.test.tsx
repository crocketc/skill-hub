import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { DirectoryPicker } from "../../platform/directoryPicker";
import { type AgentFacade, customAgentFixture } from "./api";
import { CustomAgentForm } from "./CustomAgentForm";

function facadeWith(overrides: Partial<AgentFacade> = {}): AgentFacade {
  return {
    get: async () => customAgentFixture(),
    list: async () => [customAgentFixture()],
    rescan: async () => undefined,
    createCustomAgent: vi.fn(async () => undefined),
    updateCustomAgent: vi.fn(async () => undefined),
    removeCustomAgent: vi.fn(async () => undefined),
    ...overrides,
  };
}

const pickingPicker: DirectoryPicker = {
  pickDirectory: vi.fn(async () => "D:/Agents/auditor"),
};

async function renderForm(props: Partial<Parameters<typeof CustomAgentForm>[0]> = {}) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <CustomAgentForm
        facade={props.facade ?? facadeWith()}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
        picker={pickingPicker}
        {...props}
      />
    </I18nextProvider>,
  );
}

it("submits validated values to create a custom agent", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();

  await renderForm({ facade });
  expect(screen.queryByDisplayValue("D:/Agents/auditor")).not.toBeInTheDocument();

  await user.type(screen.getByLabelText("显示名称"), "Auditor");
  await user.type(screen.getByLabelText("品牌"), "Beta");
  await user.type(screen.getByLabelText("官方参考链接"), "https://beta.example/docs");
  await user.click(screen.getByRole("button", { name: "选择目录" }));
  expect(await screen.findByText("D:/Agents/auditor")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(facade.createCustomAgent).toHaveBeenCalledWith({
    brand: "Beta",
    displayName: "Auditor",
    directoryPath: "D:/Agents/auditor",
    referenceUrl: "https://beta.example/docs",
  }));
  expect(facade.updateCustomAgent).not.toHaveBeenCalled();
});

it("blocks submission until every required value is present", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();

  await renderForm({ facade });

  await user.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByRole("alert")).toBeVisible();
  expect(facade.createCustomAgent).not.toHaveBeenCalled();
});

it("rejects reference URLs without an http scheme", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();

  await renderForm({ facade });
  await user.type(screen.getByLabelText("显示名称"), "Auditor");
  await user.type(screen.getByLabelText("品牌"), "Beta");
  await user.type(screen.getByLabelText("官方参考链接"), "ftp://beta.example/docs");
  await user.click(screen.getByRole("button", { name: "选择目录" }));
  await screen.findByText("D:/Agents/auditor");

  await user.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/官方参考链接/);
  expect(facade.createCustomAgent).not.toHaveBeenCalled();
});

it("prefills the form when editing an existing custom agent", async () => {
  const user = userEvent.setup();
  const facade = facadeWith();
  const onSaved = vi.fn();

  await renderForm({ agent: customAgentFixture(), facade, onSaved });

  expect(await screen.findByDisplayValue("Reviewer")).toBeVisible();
  expect(screen.getByDisplayValue("Acme")).toBeVisible();
  expect(screen.getByDisplayValue("https://acme.example/docs")).toBeVisible();
  expect(screen.getByText("D:/Agents/reviewer")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(facade.updateCustomAgent).toHaveBeenCalledWith("custom-reviewer", {
    brand: "Acme",
    displayName: "Reviewer",
    directoryPath: "D:/Agents/reviewer",
    referenceUrl: "https://acme.example/docs",
  }));
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it("keeps the form open with the native error when the facade rejects", async () => {
  const user = userEvent.setup();
  const facade = facadeWith({
    createCustomAgent: vi.fn(async () => {
      throw new Error("create_custom_agent returned an unexpected native result.");
    }),
  });

  await renderForm({ facade });
  await user.type(screen.getByLabelText("显示名称"), "Auditor");
  await user.type(screen.getByLabelText("品牌"), "Beta");
  await user.type(screen.getByLabelText("官方参考链接"), "https://beta.example/docs");
  await user.click(screen.getByRole("button", { name: "选择目录" }));
  await screen.findByText("D:/Agents/auditor");
  await user.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "create_custom_agent returned an unexpected native result.",
  );
});
