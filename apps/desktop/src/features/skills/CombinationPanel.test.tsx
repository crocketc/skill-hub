import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createSkillHubI18n } from "../../i18n";
import { CombinationPanel } from "./CombinationPanel";
import type { CombinationResult } from "../../api/bindings";

const combinations: CombinationResult[] = [
  { name: "Writing stack", members: ["skill-1", "skill-2"] },
];

function createFacade(overrides: Record<string, unknown> = {}) {
  return {
    listCombinations: vi.fn().mockResolvedValue(combinations),
    createCombination: vi.fn().mockResolvedValue(undefined),
    updateCombination: vi.fn().mockResolvedValue(undefined),
    deleteCombination: vi.fn().mockResolvedValue(undefined),
    exportCombination: vi.fn().mockResolvedValue({ path: "C:/exports/skillhub-export-1.zip" }),
    ...overrides,
  };
}

async function renderPanel(facade: ReturnType<typeof createFacade>) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <CombinationPanel
          facade={facade as never}
          skillNames={{ "skill-1": "PDF", "skill-2": "Notes" }}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("CombinationPanel", () => {
  it("lists combinations with member display names and supports deletion after confirm", async () => {
    const facade = createFacade();
    await renderPanel(facade);
    expect(await screen.findByText("Writing stack")).toBeVisible();
    expect(screen.getByText(/PDF、Notes/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "删除组合 Writing stack" }));
    expect(screen.getByRole("button", { name: "确认删除" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(facade.deleteCombination).toHaveBeenCalledWith("Writing stack"));
    await waitFor(() => expect(facade.listCombinations).toHaveBeenCalledTimes(2));
  });

  it("creates a combination from a name and selected members", async () => {
    const facade = createFacade();
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "新建组合" }));
    fireEvent.change(screen.getByLabelText("组合名称"), { target: { value: "Reading" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "PDF" }));
    fireEvent.click(screen.getByRole("button", { name: "保存组合" }));
    await waitFor(() =>
      expect(facade.createCombination).toHaveBeenCalledWith("Reading", ["skill-1"]),
    );
  });

  it("exports a combination through the standard export and shows the result path", async () => {
    const facade = createFacade();
    await renderPanel(facade);
    await screen.findByText("Writing stack");
    fireEvent.click(screen.getByRole("button", { name: "导出组合 Writing stack" }));
    expect(await screen.findByText(/skillhub-export-1.zip/)).toBeVisible();
    expect(facade.exportCombination).toHaveBeenCalledWith("Writing stack");
  });
});
