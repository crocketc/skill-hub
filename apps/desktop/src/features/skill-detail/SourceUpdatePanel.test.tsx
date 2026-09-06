import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import type { UpstreamCheckResult } from "../../api/bindings";
import { SourceUpdatePanel, type SourceUpdateFacade } from "./SourceUpdatePanel";

const result: UpstreamCheckResult = {
  skill_id: "s1",
  state: "update_available",
  local_version: "v3",
  upstream_version: "v4",
};

function makeFacade(overrides: Partial<SourceUpdateFacade> = {}): SourceUpdateFacade {
  return {
    checkSourceUpdate: async () => result,
    applySourceUpdate: async () => ({
      skill_id: "s1",
      decision: "take_upstream",
      new_version: "v4",
      deployments_need_reconciliation: false,
    }),
    ...overrides,
  };
}

async function renderPanel(facade: SourceUpdateFacade) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <SourceUpdatePanel facade={facade} skillId="s1" />
    </I18nextProvider>,
  );
}

it("reports an up-to-date source honestly", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({ checkSourceUpdate: async () => ({ ...result, state: "up_to_date" }) }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText(/已是最新/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "采用上游版本" })).not.toBeInTheDocument();
});

it("offers explicit decisions when an update is available", async () => {
  const user = userEvent.setup();
  const applySourceUpdate = vi.fn(async () => ({
    skill_id: "s1",
    decision: "take_upstream" as const,
    new_version: "v4",
    deployments_need_reconciliation: false,
  }));
  await renderPanel(makeFacade({ applySourceUpdate }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText(/本地 v3/)).toBeVisible();
  expect(screen.getByText(/上游 v4/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "采用上游版本" }));
  await waitFor(() => expect(applySourceUpdate).toHaveBeenCalledWith("s1", "take_upstream"));
  expect(await screen.findByText(/已采用上游版本/)).toBeVisible();
});

it("warns about local changes and refuses silent overwrite via take-upstream", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({ checkSourceUpdate: async () => ({ ...result, state: "update_available_with_local_changes" }) }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText(/本地有修改/)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "采用上游版本" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/覆盖这些修改/)).toBeVisible();
});

it("states honestly when a skill has no upstream to check", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({ checkSourceUpdate: async () => ({ ...result, state: "no_upstream" }) }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText(/没有可检查更新的上游来源/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "采用上游版本" })).not.toBeInTheDocument();
});

it("renders a structured native error readably instead of [object Object]", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    applySourceUpdate: async () => {
      throw {
        code: "operation.conflict",
        severity: "error",
        params: { reason: "no_upstream_source" },
        actions: [],
      };
    },
  }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toContain("[object Object]");
  expect(alert.textContent).toContain("operation.conflict");
});

it("states unavailability instead of pretending a check succeeded", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({ checkSourceUpdate: async () => ({ ...result, state: "source_unavailable" }) }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  expect(await screen.findByText(/来源暂不可用/)).toBeVisible();
});

it("surfaces the reconciliation note when deployments need it", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    applySourceUpdate: async () => ({
      skill_id: "s1",
      decision: "take_upstream",
      new_version: "v4",
      deployments_need_reconciliation: true,
    }),
  }));

  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  expect(await screen.findByText(/重新同步/)).toBeVisible();
});
