import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import { SourceUpdateCheckSummary } from "./SourceUpdateCheckSummary";
import type { SourceUpdateCheckReport } from "./api";

function report(
  skillId: string,
  name: string,
  state: SourceUpdateCheckReport["state"],
): SourceUpdateCheckReport {
  return { skillId, name, state };
}

async function renderSummary(reports: SourceUpdateCheckReport[]) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <SourceUpdateCheckSummary reports={reports} />
    </I18nextProvider>,
  );
}

describe("SourceUpdateCheckSummary", () => {
  it("groups batch check outcomes into up-to-date, upgradable and unavailable", async () => {
    await renderSummary([
      report("a", "PDF Reader", "up_to_date"),
      report("b", "Note Taker", "update_available"),
      report("c", "Code Reviewer", "update_available_with_local_changes"),
      report("d", "Lonely Skill", "source_unavailable"),
      report("e", "Private Skill", "authentication_required"),
    ]);

    const upToDate = screen.getByRole("group", { name: /已是最新/ });
    expect(within(upToDate).getByText("PDF Reader")).toBeTruthy();
    const upgradable = screen.getByRole("group", { name: /可升级/ });
    expect(within(upgradable).getByText("Note Taker")).toBeTruthy();
    expect(within(upgradable).getByText("Code Reviewer")).toBeTruthy();
    const unavailable = screen.getByRole("group", { name: /来源不可用/ });
    expect(within(unavailable).getByText("Lonely Skill")).toBeTruthy();
    const authRequired = screen.getByRole("group", { name: /需要认证/ });
    expect(within(authRequired).getByText("Private Skill")).toBeTruthy();
  });

  it("omits empty groups and keeps the honest hint about applying updates per skill", async () => {
    await renderSummary([report("a", "Lonely Skill", "source_unavailable")]);

    expect(screen.queryByRole("group", { name: /已是最新/ })).toBeNull();
    expect(screen.queryByRole("group", { name: /可升级/ })).toBeNull();
    const unavailable = screen.getByRole("group", { name: /来源不可用/ });
    expect(within(unavailable).getByText("Lonely Skill")).toBeTruthy();
    expect(screen.getByText(/Skill 详情/)).toBeTruthy();
  });
});
