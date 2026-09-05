import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { agentFixture, sharedTargetFixture } from "./api";
import { AgentDetailPage } from "./AgentDetailPage";
import { RelationsView } from "./RelationsView";

it("shows discovered directory facts without trust or usability status", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <I18nextProvider i18n={i18n}>
      <AgentDetailPage facade={{ get: async () => agentFixture(), list: async () => [agentFixture()], rescan: async () => undefined }} />
    </I18nextProvider>,
  );

  expect(await screen.findByText("已发现客户端和 Skill 目录")).toBeVisible();
  expect(screen.queryByText(/已授权|可用|验证通过/)).not.toBeInTheDocument();
  expect(screen.getByText("实验功能，仅供参考")).toBeVisible();
  expect(screen.getByText("研发中")).toBeVisible();
});

it("renders two logical clients connected to one physical directory", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <RelationsView relations={sharedTargetFixture().relations} />
    </I18nextProvider>,
  );

  expect(screen.getAllByTestId("logical-target")).toHaveLength(2);
  expect(screen.getAllByTestId("physical-target")).toHaveLength(1);
});
