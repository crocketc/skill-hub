import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { RescanWizard } from "./RescanWizard";

it("shows the active library as read-only and never exposes activation controls", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const activateLibraryRoot = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18n}>
      <RescanWizard
        libraryPath="C:\SkillHub"
        operations={{
          completeOnboarding: async () => undefined,
          discoverAgents: async () => ({ targets: [] }),
          activateLibraryRoot,
        }}
        runtime={{
          getBootstrapView: async () => { throw new Error("unused"); },
          runInitializationScan: async () => ({
            kind: "completed",
            result: { generation: { generation: 1, observed_at: 1 }, roots: [], discovered: [], visited_paths: [], reparsed_count: 0, unchanged_count: 0, errors: [] },
          }),
        }}
      />
    </I18nextProvider>,
  );

  expect(screen.getByRole("heading", { name: "重新发现 Agent 与 Skill" })).toBeVisible();
  expect(screen.getByText("C:\\SkillHub")).toBeVisible();
  expect(screen.queryByRole("button", { name: "保存并继续" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "继续" }));
  expect(activateLibraryRoot).not.toHaveBeenCalled();
});
