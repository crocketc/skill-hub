import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import { unavailableSkillDetailFacade, type SkillDetailSummary } from "./api";
import { detailFixture } from "./testFixtures";
import { DetailStatusRail } from "./DetailStatusRail";

/**
 * 2026-10-05 检查状态枚举定稿：详情侧与列表共用 5 态语义
 * （passed/warning/failed/not_checked(未运行)/unavailable），
 * 徽标 tone 与文案逐态断言，不裸露内部枚举值。
 */
const STATE_CASES: Array<{ state: SkillDetailSummary["basicCheck"]; label: string; tone: string }> = [
  { state: "passed", label: "基础检查已通过", tone: "success" },
  { state: "warning", label: "基础检查：警告", tone: "warning" },
  { state: "failed", label: "基础检查：失败", tone: "danger" },
  { state: "not_run", label: "基础检查：未运行", tone: "info" },
  { state: "unavailable", label: "基础检查：不可用", tone: "info" },
];

async function renderRail(basicCheck: SkillDetailSummary["basicCheck"]) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <DetailStatusRail
          facade={unavailableSkillDetailFacade}
          skillId="skill-pdf"
          summary={{ ...detailFixture().summary, basicCheck }}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("DetailStatusRail basic check badge", () => {
  for (const { state, label, tone } of STATE_CASES) {
    it(`renders the ${state} check state with the shared tone and a readable label`, async () => {
      await renderRail(state);
      const badge = screen.getByText(label);
      expect(badge).toBeVisible();
      expect(badge.className).toContain(`sh-status-badge--${tone}`);
      // 内部枚举值不进入界面文案。
      expect(badge.textContent).not.toBe(state);
    });
  }
});
