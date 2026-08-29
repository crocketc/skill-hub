import "@testing-library/jest-dom/vitest";

export function installDomAbortPrimitives(): void {
  if (typeof window === "undefined") return;

  // Node's Request validates AbortSignal by constructor identity. Prefer the
  // constructor used by Request, then expose it in both test realms.
  const requestSignal =
    typeof globalThis.Request === "function"
      ? new globalThis.Request("http://localhost/").signal
      : undefined;
  const requestSignalConstructor = requestSignal?.constructor;
  const controller = globalThis.AbortController;

  if (
    requestSignalConstructor &&
    controller &&
    new controller().signal.constructor === requestSignalConstructor
  ) {
    Object.defineProperty(globalThis, "AbortController", {
      configurable: true,
      value: controller,
      writable: true,
    });
    Object.defineProperty(globalThis, "AbortSignal", {
      configurable: true,
      value: requestSignalConstructor,
      writable: true,
    });
    Object.defineProperty(window, "AbortController", {
      configurable: true,
      value: controller,
      writable: true,
    });
    Object.defineProperty(window, "AbortSignal", {
      configurable: true,
      value: requestSignalConstructor,
      writable: true,
    });
  }
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
