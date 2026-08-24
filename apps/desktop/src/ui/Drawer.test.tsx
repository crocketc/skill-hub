import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, vi } from "vitest";
import { Drawer } from "./Drawer";

function DrawerHarness() {
  const [open, setOpen] = useState(false);

  return (
    <Drawer
      closeLabel="关闭"
      onOpenChange={setOpen}
      open={open}
      title="PDF Skill"
      trigger={<button type="button">PDF Skill</button>}
    >
      内容
    </Drawer>
  );
}

function mockReducedMotion(reduced: boolean) {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" ? reduced : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("returns focus to the invoking row when the drawer closes", async () => {
  mockReducedMotion(false);
  render(<DrawerHarness />);

  fireEvent.click(screen.getByRole("button", { name: "PDF Skill" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "PDF Skill" })).toHaveFocus();
  });
});

it("uses the no-transform terminal state when reduced motion is requested", () => {
  mockReducedMotion(true);
  render(
    <Drawer onOpenChange={() => undefined} open title="详情">
      内容
    </Drawer>,
  );

  expect(screen.getByTestId("drawer-panel")).toHaveAttribute(
    "data-reduced-motion",
    "true",
  );
});
