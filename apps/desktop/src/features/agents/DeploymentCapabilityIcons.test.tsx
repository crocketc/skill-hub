import { render, screen } from "@testing-library/react";
import { within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { AgentDirectoryView } from "./api";
import { DeploymentCapabilityIcons } from "./DeploymentCapabilityIcons";

const directory: AgentDirectoryView = {
  path: "C:/Users/demo/.agents/skills",
  status: "existing",
  role: "agent_user",
  isSharedDirectory: false,
  supportsSharedDirectory: true,
  sharedReference: false,
  builtin: false,
  readable: true,
  writable: true,
  available: true,
  physicalIdentityVerified: true,
  supportedModes: ["managed_copy", "directory_junction"],
  deploymentStatus: "not_deployed",
};

describe("DeploymentCapabilityIcons", () => {
  it("shows Agent compatibility independently of host modes and marks unknown yellow", async () => {
    const i18n = await createSkillHubI18n(["zh-CN"]);
    render(<DeploymentCapabilityIcons directory={{ ...directory, supportedModes: [],
      importCompatibility: { copy: "unverified", symlink: "supported", junction: "unverified" } }}
      t={(key) => String(i18n.t(key as never))} />);
    const methods = screen.getByRole("group", { name: "派发方式" });
    expect(within(methods).getByRole("img", { name: "复制导入兼容性待验证" })).toHaveClass("is-unverified");
    expect(within(methods).getByRole("img", { name: "支持链接导入" })).toHaveClass("is-supported");
  });
  it("shows copy and combined link capability with the agreed import labels", async () => {
    const i18n = await createSkillHubI18n(["zh-CN"]);
    render(
      <I18nextProvider i18n={i18n}>
        <DeploymentCapabilityIcons directory={directory} t={(key) => String(i18n.t(key as never))} />
      </I18nextProvider>,
    );

    expect(screen.getAllByLabelText(/支持.*导入/)).toHaveLength(2);
    expect(screen.getByLabelText("支持复制导入")).toBeVisible();
    expect(screen.getByLabelText("支持链接导入")).toBeVisible();
  });

  it("does not report built-in directories as importable", async () => {
    const i18n = await createSkillHubI18n(["zh-CN"]);
    render(
      <I18nextProvider i18n={i18n}>
        <DeploymentCapabilityIcons
          directory={{ ...directory, role: "builtin", builtin: true }}
          t={(key) => String(i18n.t(key as never))}
        />
      </I18nextProvider>,
    );

    expect(screen.getByLabelText("不支持复制导入")).toBeVisible();
    expect(screen.getByLabelText("不支持链接导入")).toBeVisible();
  });
});
