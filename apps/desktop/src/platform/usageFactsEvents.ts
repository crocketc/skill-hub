import type { QueryClient } from "@tanstack/react-query";
import { onAppEvent, type FactsChanged } from "../api/bindings";
import { overviewKeys } from "../features/overview/api";
import { relationshipsKeys } from "../features/relationships/api";
import { skillDetailKeys } from "../features/skill-detail/api";
import { skillLibraryKeys } from "../features/skills/api";

/** Subscribe to the native app_event bus and expose confirmed fact scopes. */
export function onUsageFactsChanged(
  listener: (facts: FactsChanged) => void,
): ReturnType<typeof onAppEvent> {
  return onAppEvent((event) => {
    if (event.type === "facts_changed") listener(event.payload);
  });
}

/** Refresh every shared projection affected by confirmed relationship facts. */
export async function refreshAllFactViews(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  refreshSnapshot: () => Promise<void>,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: overviewKeys.root }),
    queryClient.invalidateQueries({ queryKey: [relationshipsKeys.root] }),
    queryClient.invalidateQueries({ queryKey: skillDetailKeys.root }),
    queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root }),
    refreshSnapshot(),
  ]);
}
