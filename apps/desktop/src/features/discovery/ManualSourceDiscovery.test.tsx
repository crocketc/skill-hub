import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { ImportFacade, SourceDescriptor } from "../import/api";
import { ManualSourceDiscovery } from "./ManualSourceDiscovery";

const descriptor = (kind: SourceDescriptor["kind"], displayTarget: string): SourceDescriptor => ({
  displayTarget,
  executesCommand: false,
  input: displayTarget,
  kind,
});

async function renderPanel(facade: Pick<ImportFacade, "parseSource">, onOpenLocal = vi.fn()) {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ManualSourceDiscovery facade={facade} onOpenLocal={onOpenLocal} />
    </I18nextProvider>,
  );
  return onOpenLocal;
}

it("recognizes a local path and hands it to the existing import flow", async () => {
  const user = userEvent.setup();
  const onOpenLocal = await renderPanel({
    parseSource: vi.fn(async () => descriptor("local_path", "C:/skills/demo")),
  });

  await user.type(screen.getByRole("textbox", { name: "Source" }), "C:/skills/demo");
  await user.click(screen.getByRole("button", { name: "Parse source" }));

  expect(await screen.findByText("Local path")).toBeVisible();
  expect(onOpenLocal).toHaveBeenCalledWith("C:/skills/demo");
});

it("recognizes remote and npx formats without pretending they are importable", async () => {
  const user = userEvent.setup();
  const parseSource = vi.fn()
    .mockResolvedValueOnce(descriptor("url", "https://github.com/example/skills"))
    .mockResolvedValueOnce(descriptor("npx_reference", "example/skills"));
  await renderPanel({ parseSource });

  const input = screen.getByRole("textbox", { name: "Source" });
  await user.type(input, "https://github.com/example/skills");
  await user.click(screen.getByRole("button", { name: "Parse source" }));
  expect(await screen.findByText("Recognized, import is not supported yet.")).toBeVisible();

  await user.clear(input);
  await user.type(input, "npx skills add example/skills");
  await user.click(screen.getByRole("button", { name: "Parse source" }));
  expect(await screen.findByText("Recognized, import is not supported yet.")).toBeVisible();
});

it("shows a recoverable error when source parsing fails", async () => {
  const user = userEvent.setup();
  await renderPanel({ parseSource: vi.fn(async () => { throw new Error("source.invalid_input"); }) });

  await user.type(screen.getByRole("textbox", { name: "Source" }), "not a source");
  await user.click(screen.getByRole("button", { name: "Parse source" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Could not parse this source.");
});
