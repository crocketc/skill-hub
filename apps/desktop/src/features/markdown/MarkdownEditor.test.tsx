import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { MarkdownEditor } from "./MarkdownEditor";
import {
  createMockMarkdownFacade,
  type MockMarkdownOptions,
} from "./testFixtures";

async function renderEditor(options: MockMarkdownOptions = {}) {
  const facade = createMockMarkdownFacade(options);
  const file = await facade.readMarkdownFile("pdf-reader", "SKILL.md");
  const i18n = await createSkillHubI18n(["en-US"]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MarkdownEditor
          facade={facade}
          file={file}
          onSaved={() => undefined}
          skillId="pdf-reader"
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return facade;
}

async function replaceEditorText(text: string) {
  const user = userEvent.setup();
  const editor = screen.getByRole("textbox", { name: "Markdown source" });
  await user.click(editor);
  await user.keyboard("{Control>}a{/Control}");
  await user.paste(text);
}

describe("MarkdownEditor", () => {
  it("persists a draft without creating a version until explicit save", async () => {
    const facade = await renderEditor();
    await replaceEditorText("A changed");

    expect(await screen.findByText("Draft saved locally")).toBeVisible();
    expect(facade.calls.savedVersions).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));

    expect(await screen.findByText("Version v2 created")).toBeVisible();
    expect(facade.calls.savedVersions).toHaveLength(1);
    expect(facade.calls.savedVersions[0]?.markdown).toBe("A changed");
  });

  it("keeps the source and draft when blocking validation prevents save", async () => {
    const facade = await renderEditor({
      validationIssues: [
        { code: "frontmatter", message: "Missing name", severity: "error" },
      ],
    });
    await replaceEditorText("Unsaved work");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));

    expect(await screen.findByRole("alert", { name: "Save issues" })).toHaveTextContent(
      "Missing name",
    );
    expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
      "Unsaved work",
    );
    expect(facade.calls.savedVersions).toEqual([]);
  });

  it("requires an explicit continuation before saving validation warnings", async () => {
    const facade = await renderEditor({
      validationIssues: [
        { code: "reference", message: "Image is missing", severity: "warning" },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));
    expect(await screen.findByText("Image is missing")).toBeVisible();
    expect(facade.calls.savedVersions).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save despite warnings" }));
    expect(await screen.findByText("Version v2 created")).toBeVisible();
  });

  it("retains the editor value when the formal save fails", async () => {
    await renderEditor({ failSave: true });
    await replaceEditorText("Keep this draft");
    await screen.findByText("Draft saved locally");

    fireEvent.click(screen.getByRole("button", { name: "Save and create version" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save; your local draft is still available.",
    );
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveTextContent(
        "Keep this draft",
      );
    });
  });
});
