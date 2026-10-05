import { render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { SkillUpstreamLineage } from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import { UpstreamLineage } from "./UpstreamLineage";

/**
 * K5/MS-04：详情页上游谱系的展示契约——
 * 无登记不渲染区块（诚实缺省）；来源显示名可解析时以链接语义呈现；
 * 来源主体已删除时诚实呈现无标签形态，不编造名称。
 */
async function renderLineage(lineage: SkillUpstreamLineage | null | undefined) {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <UpstreamLineage lineage={lineage} />
        </MemoryRouter>
      </I18nextProvider>
    </ThemeProvider>,
  );
}

describe("UpstreamLineage", () => {
  it("renders nothing when no lineage is registered", async () => {
    await renderLineage(undefined);
    expect(screen.queryByTestId("upstream-lineage")).not.toBeInTheDocument();
  });

  it("links the resolvable source display name without exposing raw ids", async () => {
    await renderLineage({
      created_at: "1728000000",
      source_display_name: "Source skill",
      source_skill_id: "skill-src",
      source_version_id: "ver-src",
    });
    const block = screen.getByTestId("upstream-lineage");
    expect(within(block).getByRole("link", { name: "Source skill" })).toHaveAttribute(
      "href",
      "/library/skill-src",
    );
    // 内部标识不裸露：skill id 与 version id 都不直接可见。
    expect(within(block).queryByText("skill-src")).not.toBeInTheDocument();
    expect(within(block).queryByText("ver-src")).not.toBeInTheDocument();
  });

  it("presents the honest no-label form when the source skill is gone", async () => {
    await renderLineage({
      created_at: null,
      source_display_name: null,
      source_skill_id: "skill-gone",
      source_version_id: "ver-gone",
    });
    const block = screen.getByTestId("upstream-lineage");
    expect(block).toHaveTextContent(/no longer available/i);
    // 来源名不可解析：不编造标签，也不渲染指向已删除主体的链接。
    expect(within(block).queryByRole("link")).not.toBeInTheDocument();
  });
});
