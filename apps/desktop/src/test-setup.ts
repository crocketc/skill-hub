import "@testing-library/jest-dom/vitest";

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
