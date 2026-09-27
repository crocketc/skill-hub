const eventName = "skillhub:pending-facts-changed";
export function emitPendingFactsChanged() { window.dispatchEvent(new Event(eventName)); }
export function onPendingFactsChanged(listener: () => void) {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}
