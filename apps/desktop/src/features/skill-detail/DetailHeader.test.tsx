import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { SkillDetailSummary } from "./api";
import { DetailHeader } from "./DetailHeader";

/**
 * W3-1（FB-003 裁决第 1 节）：安全预警 Skill 的头部提供唯一的「安全处理」
 * 入口（去安全页处理预警）；无预警时不渲染，动作缺失时也不渲染死按钮。
 */
async function renderHeader(summary: SkillDetailSummary, onSecurityHandling?: () => void) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <DetailHeader onSecurityHandling={onSecurityHandling} summary={summary} />
    </I18nextProvider>,
  );
}

const baseSummary: SkillDetailSummary = {
  aiCheck: "not_run",
  basicCheck: "passed",
  currentVersion: "1.0.0",
  id: "skill-1",
  lifecycle: "active",
  name: "PDF Reader",
  purpose: "Read PDFs",
};

describe("DetailHeader security handling entry", () => {
  it("offers the security handling entry when the projection carries an alert", async () => {
    const onSecurityHandling = vi.fn();
    await renderHeader({ ...baseSummary, securityAlert: "warning" }, onSecurityHandling);

    const entry = screen.getByRole("button", { name: "安全处理" });
    await userEvent.click(entry);
    expect(onSecurityHandling).toHaveBeenCalledOnce();
  });

  it("renders no security handling entry when the summary carries no alert", async () => {
    await renderHeader(baseSummary, vi.fn());

    expect(screen.queryByRole("button", { name: "安全处理" })).not.toBeInTheDocument();
  });

  it("renders no dead entry when the alert exists but the handler is unavailable", async () => {
    await renderHeader({ ...baseSummary, securityAlert: "danger" });

    expect(screen.queryByRole("button", { name: "安全处理" })).not.toBeInTheDocument();
  });
});
