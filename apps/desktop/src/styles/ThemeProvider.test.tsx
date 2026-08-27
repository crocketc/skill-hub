import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from "./ThemeProvider";

function ThemeHarness() {
  const { appearance, resolvedTheme, setAppearance } = useTheme();

  return (
    <>
      <output>{`${appearance}:${resolvedTheme}`}</output>
      <button onClick={() => setAppearance("roast")} type="button">
        Choose roast
      </button>
    </>
  );
}

function mockColorScheme(initiallyDark: boolean) {
  let dark = initiallyDark;
  const listeners = new Set<() => void>();
  const media = {
    get matches() {
      return dark;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn((_event: string, listener: () => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_event: string, listener: () => void) => {
      listeners.delete(listener);
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));

  return (nextDark: boolean) => {
    dark = nextDark;
    listeners.forEach((listener) => listener());
  };
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});

it("applies the system theme and responds to operating-system changes", () => {
  const setSystemDark = mockColorScheme(false);
  render(
    <ThemeProvider>
      <ThemeHarness />
    </ThemeProvider>,
  );

  expect(document.documentElement).toHaveAttribute("data-theme", "moss-neutral");

  act(() => setSystemDark(true));

  expect(document.documentElement).toHaveAttribute("data-theme", "grok-night");
  expect(screen.getByText("system:grok-night")).toBeInTheDocument();
});

it("loads and persists a manually selected complete palette", () => {
  mockColorScheme(true);
  localStorage.setItem(THEME_STORAGE_KEY, "sakura");
  render(
    <ThemeProvider>
      <ThemeHarness />
    </ThemeProvider>,
  );

  expect(document.documentElement).toHaveAttribute("data-theme", "sakura");
  fireEvent.click(screen.getByRole("button", { name: "Choose roast" }));
  expect(document.documentElement).toHaveAttribute("data-theme", "roast");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("roast");
});

it("falls back to the neutral system theme for an invalid stored value", () => {
  mockColorScheme(false);
  localStorage.setItem(THEME_STORAGE_KEY, "unknown-theme");
  render(
    <ThemeProvider>
      <ThemeHarness />
    </ThemeProvider>,
  );

  expect(screen.getByText("system:moss-neutral")).toBeInTheDocument();
  expect(document.documentElement).toHaveAttribute("data-theme", "moss-neutral");
});
