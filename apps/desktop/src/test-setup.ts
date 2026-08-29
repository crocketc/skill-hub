import "@testing-library/jest-dom/vitest";

export function installDomAbortPrimitives(): void {
  if (typeof window === "undefined") return;

  if (globalThis.AbortController !== window.AbortController) {
    Object.defineProperty(globalThis, "AbortController", {
      configurable: true,
      value: window.AbortController,
      writable: true,
    });
  }
  if (globalThis.AbortSignal !== window.AbortSignal) {
    Object.defineProperty(globalThis, "AbortSignal", {
      configurable: true,
      value: window.AbortSignal,
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
