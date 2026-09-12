import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import type { ClientKind } from "../api/bindings";
import { createSkillHubI18n } from "../i18n";
import { AgentKindBadge } from "./AgentKindBadge";

async function renderBadge(kinds: ClientKind[]) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <AgentKindBadge kinds={kinds} />
    </I18nextProvider>,
  );
}

// P1-06：类型徽标是发现卡片上唯一的适配器证据出口，标签合并与回退
// 必须确定，避免出现 undefined 或英文键名。
it("joins multiple client kinds with a slash in the given order", async () => {
  const { container } = await renderBadge(["desktop", "cli"]);

  const badge = container.querySelector(".sh-agent-kind-badge");
  expect(badge).not.toBeNull();
  expect(badge).toHaveTextContent("桌面端/CLI");
  expect(screen.getByTitle("类型来自该客户端配置档案中声明的适配器证据")).toBeVisible();
});

it("renders a single kind through its catalog label", async () => {
  const { container } = await renderBadge(["ide_extension"]);

  expect(container.querySelector(".sh-agent-kind-badge")).toHaveTextContent("IDE 插件");
});

it("returns nothing when the directory card has no client kind", async () => {
  const { container } = await renderBadge([]);

  expect(container.querySelector(".sh-agent-kind-badge")).toBeNull();
});

it("falls back to the raw value for unknown kinds instead of showing undefined", async () => {
  const { container } = await renderBadge(["cli", "quantum" as ClientKind]);

  expect(container.querySelector(".sh-agent-kind-badge")).toHaveTextContent("CLI/quantum");
});
