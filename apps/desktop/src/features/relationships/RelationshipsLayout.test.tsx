import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { RelationshipsLayout } from "./RelationshipsLayout";

async function renderLayout(scope: "graph" | "decisions" | "governance") {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <RelationshipsLayout scope={scope} />
    </I18nextProvider>,
  );
}

describe("RelationshipsLayout", () => {
  it("owns the route-level h1 and shows an honest unavailable placeholder per scope", async () => {
    await renderLayout("graph");
    expect(screen.getByRole("heading", { level: 1, name: "Skill graph" })).toBeVisible();
    expect(
      screen.getByText(
        "The relationship graph canvas is not available yet; relation facts stay available in the Skill library and on Skill details.",
      ),
    ).toBeVisible();

    await renderLayout("decisions");
    const [second] = screen.getAllByRole("heading", { level: 1, name: "Conflict decisions" });
    expect(second).toBeVisible();

    await renderLayout("governance");
    const [third] = screen.getAllByRole("heading", {
      level: 1,
      name: "Relationship governance",
    });
    expect(third).toBeVisible();
  });

  it("renders provided page content instead of the placeholder when a page supplies children", async () => {
    const i18n = await createSkillHubI18n(["en-US"]);
    render(
      <I18nextProvider i18n={i18n}>
        <RelationshipsLayout scope="graph">
          <p>Real canvas content</p>
        </RelationshipsLayout>
      </I18nextProvider>,
    );

    expect(screen.getByText("Real canvas content")).toBeVisible();
    expect(
      screen.queryByText(/not available yet/),
    ).not.toBeInTheDocument();
  });
});
