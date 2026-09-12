import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../i18n";
import type { BootstrapSnapshot } from "../api/bindings";
import type { BootstrapVerificationState } from "../features/bootstrap/api";
import {
  beginBackgroundScan,
  resetBackgroundScan,
  type ScanResult,
} from "../features/bootstrap/backgroundScan";
import { AppShell } from "./AppShell";

const completedScan: ScanResult = {
  generation: { generation: 1, observed_at: 1 },
  roots: [],
  discovered: [],
  visited_paths: [],
  reparsed_count: 0,
  unchanged_count: 0,
  errors: [],
};

afterEach(() => {
  resetBackgroundScan();
});

async function renderShell() {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <MemoryRouter initialEntries={["/"]}>
      <I18nextProvider i18n={i18n}>
        <AppShell
          refreshSnapshot={async () => undefined}
          snapshot={{} as unknown as BootstrapSnapshot}
          verification={{ kind: "idle" } as unknown as BootstrapVerificationState}
        />
      </I18nextProvider>
    </MemoryRouter>,
  );
}

describe("AppShell", () => {
  it("exposes exactly one main landmark for the workspace", async () => {
    await renderShell();

    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("offers a skip link as the first focusable element and targets the main region", async () => {
    const user = userEvent.setup();
    await renderShell();

    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus();

    const skipLink = screen.getByRole("link", { name: "Skip to content" });
    const main = screen.getByRole("main");
    expect(skipLink).toHaveAttribute("href", `#${main.id}`);
    expect(main).toHaveAttribute("tabindex", "-1");
  });

  it("keeps the sidebar navigation after the skip link in tab order", async () => {
    const user = userEvent.setup();
    await renderShell();

    await user.tab();
    await user.tab();
    expect(screen.getByRole("complementary", { name: "Main navigation" })).toContainElement(
      document.activeElement as HTMLElement | null,
    );
  });

  it("reports a handed-off background scan through the shell notification service", async () => {
    await renderShell();

    beginBackgroundScan(Promise.resolve({ kind: "completed", result: completedScan }), []);

    expect(await screen.findByText("Background scan finished")).toBeVisible();
  });
});
