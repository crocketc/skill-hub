import { useCallback, useEffect, useRef, useState } from "react";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { onDeploymentFactsChanged } from "../../platform/deploymentEvents";
import { onDiscoveryFactsChanged } from "../../platform/discoveryEvents";
import type { PendingFacade, PendingItem } from "./api";

/** Both the overview and inbox refresh the same projection of current facts. */
export function usePendingItems(facade?: Pick<PendingFacade, "list">, tracker: OperationTracker = operationTracker) {
  const [items, setItems] = useState<PendingItem[]>();
  const [error, setError] = useState<unknown>();
  const generation = useRef(0);
  const reload = useCallback(() => {
    if (!facade) return;
    const request = ++generation.current;
    void facade.list().then((next) => {
      if (request !== generation.current) return;
      setItems(next);
      setError(undefined);
    }, (reason: unknown) => {
      if (request === generation.current) setError(reason);
    });
  }, [facade]);
  useEffect(() => {
    if (!facade) return;
    reload();
    const visible = () => { if (document.visibilityState === "visible") reload(); };
    const signature = () => tracker.getSnapshot()
      .filter((operation) => operation.finishedAt !== null || operation.status === "needs_user")
      .map((operation) => `${operation.id}:${operation.status}:${operation.finishedAt}`).join("|");
    let previous = signature();
    const unsubscribe = tracker.subscribe(() => {
      const next = signature();
      if (next !== previous) { previous = next; reload(); }
    });
    const stopDeployment = onDeploymentFactsChanged(reload);
    const stopDiscovery = onDiscoveryFactsChanged(reload);
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", visible);
    return () => {
      generation.current++;
      unsubscribe(); stopDeployment(); stopDiscovery();
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [facade, reload, tracker]);
  return { items, error, reload };
}
