import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { skillHubI18n } from "../i18n";
import { AppRouter } from "./router";

function mockBrowserPreferences() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("lang");
  vi.unstubAllGlobals();
});

it("wires theme, language, data and motion providers at the production entry", async () => {
  mockBrowserPreferences();
  await skillHubI18n.changeLanguage("en-US");

  render(<AppRouter />);

  expect(await screen.findByText("Reading local data")).toBeInTheDocument();
  expect(document.documentElement).toHaveAttribute("data-theme", "moss-neutral");
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("lang", "en-US");
  });
});
