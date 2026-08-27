import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { MarkdownWorkspace } from "./MarkdownWorkspace";
import {
  createMockMarkdownFacade,
  type MockMarkdownFacade,
  type MockMarkdownOptions,
} from "./testFixtures";

async function renderWorkspace(
  options: MockMarkdownOptions = {},
  setup?: (facade: MockMarkdownFacade) => Promise<void>,
) {
  const facade = createMockMarkdownFacade(options);
  await setup?.(facade);
  const i18n = await createSkillHubI18n(["en-US"]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MarkdownWorkspace facade={facade} skillId="pdf-reader" />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return facade;
}

describe("MarkdownWorkspace", () => {
  it("opens SKILL.md first and switches other Markdown files independently", async () => {
    await renderWorkspace();

    expect(await screen.findByRole("heading", { name: "Markdown workspace" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Markdown file" })).toHaveValue(
      "SKILL.md",
    );
    expect(
      await screen.findByRole("heading", { name: "Extract PDF tables safely" }),
    ).toBeVisible();

    fireEvent.change(screen.getByRole("combobox", { name: "Markdown file" }), {
      target: { value: "docs/usage.md" },
    });

    expect(await screen.findByRole("heading", { name: "Usage notes" })).toBeVisible();
  });

  it("switches between read, source and edit without rewriting unknown source", async () => {
    await renderWorkspace();
    await screen.findByRole("heading", { name: "Extract PDF tables safely" });

    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByText("name: pdf-reader", { exact: false })).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Markdown source" })).toBeVisible();
  });

  it("never offers in-place edit for a read-only external Skill", async () => {
    const facade = await renderWorkspace({ editable: false, readOnlyReason: "external" });

    expect(
      await screen.findByText("This file is read-only because it is managed externally."),
    ).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Edit" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy into SkillHub" }));
    expect(facade.calls.takeovers).toEqual(["pdf-reader"]);
  });

  it("restores a local draft by default and can discard it explicitly", async () => {
    const facade = await renderWorkspace({}, async (fixture) => {
      await fixture.saveDraft("pdf-reader", "SKILL.md", "# Recovered draft");
    });

    expect(await screen.findByText("A local draft was restored.")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
      "# Recovered draft",
    );

    fireEvent.click(screen.getByRole("button", { name: "Discard local draft" }));
    await waitFor(() => {
      expect(screen.queryByText("A local draft was restored.")).not.toBeInTheDocument();
    });
    expect(facade.calls.discardedDrafts).toEqual([
      { path: "SKILL.md", skillId: "pdf-reader" },
    ]);
  });

  it("routes external application and folder actions through the facade", async () => {
    const facade = await renderWorkspace();
    await screen.findByRole("heading", { name: "Extract PDF tables safely" });

    fireEvent.click(screen.getByRole("button", { name: "Open in default app" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose another app" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Skill folder" }));

    expect(facade.calls.openedDefaults).toEqual([
      { path: "SKILL.md", skillId: "pdf-reader" },
    ]);
    expect(facade.calls.chosenApplications).toEqual([
      { path: "SKILL.md", skillId: "pdf-reader" },
    ]);
    expect(facade.calls.openedFolders).toEqual(["pdf-reader"]);
  });
});
