import { useMemo, useSyncExternalStore } from "react";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { onDeploymentFactsChanged } from "../../platform/deploymentEvents";
import { onDiscoveryFactsChanged } from "../../platform/discoveryEvents";
import { onPendingFactsChanged } from "../../platform/pendingEvents";
import type { PendingFacade, PendingItem } from "./api";

type Facade = Pick<PendingFacade, "list" | "workspace">;
type Snapshot = { items?: PendingItem[]; error?: unknown; unavailableSources: string[] };
const stores = new WeakMap<Facade, Map<OperationTracker, ReturnType<typeof createStore>>>();
const empty: Snapshot = { unavailableSources: [] };

/** One current-facts projection shared by navigation, overview and the workbench. */
export function createStore(facade: Facade, tracker: OperationTracker) {
  let snapshot: Snapshot = empty;
  let inFlight = false;
  let rerun = false;
  let scheduled = false;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const readNow = () => {
    scheduled = false;
    if (inFlight) { rerun = true; return; }
    inFlight = true;
    const read = facade.workspace ? facade.workspace() : facade.list().then((items) => ({ items, unavailableSources: [] }));
    void read.then((next) => {
      // Partial reads do not erase last known work from an unavailable source.
      const items = next.unavailableSources.length && snapshot.items
        ? [...new Map([...snapshot.items.filter((item) => next.unavailableSources.includes(
          item.kind === "governance_followup" ? "governance_followups" : item.kind === "recovery" ? "recovery" : item.kind === "conflict" ? "conflicts" : item.kind === "governance" ? "governance" : item.kind === "ai_setup" ? "ai" : "catalog"
        )), ...next.items].map((item) => [item.id, item])).values()]
        : next.items;
      snapshot = { items, unavailableSources: next.unavailableSources };
    }, (error: unknown) => { snapshot = { ...snapshot, error }; }).finally(() => {
      inFlight = false; publish();
      if (rerun) { rerun = false; reload(); }
    });
  };
  const reload = () => { if (!scheduled) { scheduled = true; queueMicrotask(readNow); } };
  return {
    getSnapshot: () => snapshot,
    reload,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        const visible = () => { if (document.visibilityState === "visible") reload(); };
        const signature = () => tracker.getSnapshot().filter((operation) => operation.finishedAt !== null || operation.status === "needs_user")
          .map((operation) => `${operation.id}:${operation.status}:${operation.finishedAt}`).join("|");
        let previous = signature();
        const unsubscribe = tracker.subscribe(() => { const next = signature(); if (next !== previous) { previous = next; reload(); } });
        const stops = [unsubscribe, onDeploymentFactsChanged(reload), onDiscoveryFactsChanged(reload), onPendingFactsChanged(reload)];
        window.addEventListener("focus", reload);
        document.addEventListener("visibilitychange", visible);
        stop = () => { stops.forEach((fn) => fn()); window.removeEventListener("focus", reload); document.removeEventListener("visibilitychange", visible); };
        reload();
      }
      return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = undefined; } };
    },
  };
}

const emptyStore = { getSnapshot: () => empty, subscribe: () => () => undefined, reload: () => undefined };
export function usePendingItems(facade?: Facade, tracker: OperationTracker = operationTracker) {
  const store = useMemo(() => {
    if (!facade) return emptyStore;
    let entries = stores.get(facade);
    if (!entries) { entries = new Map(); stores.set(facade, entries); }
    let entry = entries.get(tracker);
    if (!entry) { entry = createStore(facade, tracker); entries.set(tracker, entry); }
    return entry;
  }, [facade, tracker]);
  return { ...useSyncExternalStore(store.subscribe, store.getSnapshot), reload: store.reload };
}
