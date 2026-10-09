import type { FactsChanged } from "../api/bindings";

const eventName = "skillhub:pending-facts-changed";
export function emitPendingFactsChanged(facts?: FactsChanged) {
  window.dispatchEvent(new CustomEvent<FactsChanged | undefined>(eventName, { detail: facts }));
}
export function onPendingFactsChanged(listener: (facts?: FactsChanged) => void) {
  const receive = (event: Event) => {
    listener((event as CustomEvent<FactsChanged | undefined>).detail);
  };
  window.addEventListener(eventName, receive);
  return () => window.removeEventListener(eventName, receive);
}
