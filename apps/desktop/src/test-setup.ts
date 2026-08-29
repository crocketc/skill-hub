import "@testing-library/jest-dom/vitest";

let requestRealmAdapterInstalled = false;

export function installDomAbortPrimitives(): void {
  if (
    typeof window === "undefined" ||
    requestRealmAdapterInstalled ||
    typeof globalThis.Request !== "function"
  ) {
    return;
  }

  const nativeRequest = globalThis.Request;

  class RequestRealmAdapter extends nativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      const signal = init?.signal;
      super(input, signal ? { ...init, signal: undefined } : init);

      if (signal) {
        Object.defineProperty(this, "signal", {
          configurable: true,
          value: signal,
        });
      }
    }
  }

  Object.defineProperty(globalThis, "Request", {
    configurable: true,
    value: RequestRealmAdapter,
    writable: true,
  });
  requestRealmAdapterInstalled = true;
}

installDomAbortPrimitives();

const noRects: DOMRect[] = [];
const emptyClientRects: DOMRectList = {
  item: () => null,
  length: 0,
  [Symbol.iterator]: () => noRects.values(),
};

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => emptyClientRects;
}

if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
