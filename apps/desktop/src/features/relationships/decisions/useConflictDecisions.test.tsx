import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../../i18n";
import { relationshipsKeys } from "../api";
import type { ConflictDecisionsFacade } from "./decisionsApi";
import { useConflictAiAvailability } from "./useConflictDecisions";

function AvailabilityProbe({ facade }: { facade: ConflictDecisionsFacade }) {
  const { available } = useConflictAiAvailability(facade);
  return <output>{available === null ? "pending" : available ? "available" : "unavailable"}</output>;
}

describe("conflict decision query namespace", () => {
  it("keeps AI availability under the relationships root so root invalidation reaches it", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const isAiAvailable = vi.fn(async () => true);
    const facade = {
      isAiAvailable,
    } as ConflictDecisionsFacade;

    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AvailabilityProbe facade={facade} />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    );

    expect(await screen.findByText("available")).toBeVisible();
    const query = queryClient.getQueryCache().find({
      queryKey: [relationshipsKeys.root, "decisions", "ai-available"],
    });
    expect(query?.queryKey).toEqual([relationshipsKeys.root, "decisions", "ai-available"]);

    await queryClient.invalidateQueries({ queryKey: [relationshipsKeys.root] });
    await waitFor(() => expect(isAiAvailable).toHaveBeenCalledTimes(2));
  });
});
