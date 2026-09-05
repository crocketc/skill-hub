import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
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

it("does not submit an empty source", async () => {
  const user = userEvent.setup();
  const relinkSource = vi.fn(async () => ({ messageCode: "source.relinked" }));
  await renderPanel(makeFacade({ relinkSource }));

  await user.click(screen.getByRole("button", { name: "重新关联" }));
  expect(relinkSource).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "重新关联" })).toBeDisabled();
});
