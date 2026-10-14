import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AnalyzeConflictScope } from "../../../api/bindings";
import { createSkillHubI18n } from "../../../i18n";
import { createOperationTracker } from "../../../platform/operationTracker";
import type { ConflictDecisionsFacade } from "./decisionsApi";
import { useConflictAiAnalysis } from "./useConflictDecisions";

function AnalysisProbe({ facade }: { facade: ConflictDecisionsFacade }) {
  const analysis = useConflictAiAnalysis({ facade, canRun: false, tracker: createOperationTracker() });
  return (
    <button onClick={() => analysis.run({ type: "all" })} type="button">
      Run analysis
    </button>
  );
}

describe("conflict analysis execution guard", () => {
  it("does not submit an AI analysis when the shared capability is not ready", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const analyzeConflict = vi.fn(async (_scope: AnalyzeConflictScope) => {
      throw new Error("blocked analysis must not reach the facade");
    });
    const facade = { analyzeConflict } as unknown as ConflictDecisionsFacade;

    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AnalysisProbe facade={facade} />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run analysis" }));
    expect(analyzeConflict).not.toHaveBeenCalled();
  });
});
