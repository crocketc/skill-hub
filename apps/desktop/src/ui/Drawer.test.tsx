import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useRef, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, vi } from "vitest";
import { createSkillHubI18n, skillHubI18n } from "../i18n";
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

function ExternallyControlledDrawerHarness() {
  const [open, setOpen] = useState(false);
  const returnFocusRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        ref={returnFocusRef}
        type="button"
      >
        Open details
      </button>
      <Drawer
        onOpenChange={setOpen}
        open={open}
        returnFocusRef={returnFocusRef}
        title="Details"
      >
        Content
      </Drawer>
    </>
  );
}

interface OpenDrawerHarnessProps {
  children: ReactNode;
  title: string;
}

function OpenDrawerHarness({ children, title }: OpenDrawerHarnessProps) {
  const returnFocusRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button ref={returnFocusRef} type="button">
        Return target
      </button>
      <Drawer
        onOpenChange={() => undefined}
        open
        returnFocusRef={returnFocusRef}
        title={title}
      >
        {children}
      </Drawer>
    </>
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
  render(
    <I18nextProvider i18n={skillHubI18n}>
      <DrawerHarness />
    </I18nextProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "PDF Skill" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "PDF Skill" })).toHaveFocus();
  });
});

it("uses the no-transform terminal state when reduced motion is requested", () => {
  mockReducedMotion(true);
  render(
    <I18nextProvider i18n={skillHubI18n}>
      <OpenDrawerHarness title="详情">内容</OpenDrawerHarness>
    </I18nextProvider>,
  );

  expect(screen.getByTestId("drawer-panel")).toHaveAttribute(
    "data-reduced-motion",
    "true",
  );
});

it("localizes the default close action", async () => {
  mockReducedMotion(false);
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <OpenDrawerHarness title="详情">内容</OpenDrawerHarness>
    </I18nextProvider>,
  );

  expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
});

it("restores focus for an externally controlled drawer without a trigger", async () => {
  mockReducedMotion(false);
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <ExternallyControlledDrawerHarness />
    </I18nextProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Open details" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Open details" })).toHaveFocus();
  });
});
