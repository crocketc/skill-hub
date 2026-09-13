import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { LibraryViewMode } from "./api";
import {
  isLibraryViewModeRoute,
  LibraryViewModeProvider,
  LibraryViewModeSwitch,
  useLibraryViewMode,
  type LibraryViewModeContextValue,
} from "./libraryViewContext";

describe("isLibraryViewModeRoute", () => {
  it("shows the switch only on the library tab and its preview route", () => {
    expect(isLibraryViewModeRoute("/library")).toBe(true);
    expect(isLibraryViewModeRoute("/__preview/skill-library")).toBe(true);
  });

  it("hides the switch on library sub-routes, detail previews and other tabs", () => {
    const hiddenRoutes = [
      "/library/combinations",
      "/library/skill-pdf",
      "/library/skill-pdf/deploy",
      "/library/skill-pdf/security",
      "/__preview/skill-detail/skill-pdf",
      "/",
      "/agents",
      "/discovery",
      "/settings",
    ];
    for (const pathname of hiddenRoutes) {
      expect(isLibraryViewModeRoute(pathname), pathname).toBe(false);
    }
  });
});

function ContextProbe({ onState }: { onState?: (value: LibraryViewModeContextValue) => void }) {
  const state = useLibraryViewMode();
  onState?.(state);
  return (
    <div>
      <span data-testid="probe-view">{state.viewMode}</span>
      <span data-testid="probe-hydrated">{String(state.hydrated)}</span>
      <button
        type="button"
        onClick={() => state.changeViewMode("matrix" satisfies LibraryViewMode)}
      >
        probe-change-matrix
      </button>
      <button
        type="button"
        onClick={() => state.hydrateViewMode("table" satisfies LibraryViewMode)}
      >
        probe-hydrate-table
      </button>
    </div>
  );
}

async function renderWithContext(children: React.ReactNode) {
  const i18n = await createSkillHubI18n(["en-US"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <LibraryViewModeProvider>{children}</LibraryViewModeProvider>
    </I18nextProvider>,
  );
}

describe("LibraryViewModeProvider", () => {
  it("starts on the default card view before hydration", async () => {
    await renderWithContext(<ContextProbe />);

    expect(screen.getByTestId("probe-view")).toHaveTextContent("cards");
    expect(screen.getByTestId("probe-hydrated")).toHaveTextContent("false");
  });

  it("marks the context hydrated when the page hands over the persisted mode", async () => {
    const user = userEvent.setup();
    await renderWithContext(<ContextProbe />);

    await user.click(screen.getByRole("button", { name: "probe-hydrate-table" }));

    expect(screen.getByTestId("probe-view")).toHaveTextContent("table");
    expect(screen.getByTestId("probe-hydrated")).toHaveTextContent("true");
  });

  it("propagates context changes to every consumer sharing the state", async () => {
    const user = userEvent.setup();
    await renderWithContext(
      <>
        <LibraryViewModeSwitch />
        <ContextProbe />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "probe-change-matrix" }));

    expect(screen.getByTestId("probe-view")).toHaveTextContent("matrix");
    expect(screen.getByRole("button", { name: "Relations matrix" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("LibraryViewModeSwitch", () => {
  it("keeps the stable group structure with the three pressed-state buttons", async () => {
    await renderWithContext(<LibraryViewModeSwitch />);

    const group = screen.getByRole("group", { name: "View mode" });
    expect(group).toHaveClass("sh-skill-library__mode-switch");
    expect(screen.getByRole("button", { name: "Table view" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Card view" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Relations matrix" })).toHaveAttribute("aria-pressed", "false");
  });

  it("moves the pressed state when a mode button is activated", async () => {
    const user = userEvent.setup();
    await renderWithContext(<LibraryViewModeSwitch />);

    await user.click(screen.getByRole("button", { name: "Table view" }));

    expect(screen.getByRole("button", { name: "Table view" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Card view" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Relations matrix" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("useLibraryViewMode", () => {
  it("throws when consumed outside the provider", () => {
    expect(() => render(<ContextProbe />)).toThrow(/LibraryViewModeProvider/);
  });
});
