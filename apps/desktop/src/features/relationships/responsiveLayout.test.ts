import { describe, expect, it } from "vitest";
import graphCss from "./graph/graph.css?raw";
import decisionsCss from "./decisions/decisions.css?raw";
import governanceCss from "./governance/governance.css?raw";
import relationshipsCss from "./relationships.css?raw";

describe("relationship workbench layout at a compact 800x600 window", () => {
  it("passes the available page height through the relationship graph workbench", () => {
    expect(relationshipsCss).toMatch(
      /\.sh-relationships\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\)[\s\S]*?height:\s*100%[\s\S]*?min-height:\s*0/,
    );
    expect(graphCss).toMatch(
      /\.sh-graph\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\) auto[\s\S]*?min-height:\s*0/,
    );
    expect(graphCss).toMatch(
      /\.sh-graph__body\s*\{[\s\S]*?min-height:\s*0/,
    );
    expect(graphCss).toMatch(
      /\.sh-graph-canvas\s*\{[\s\S]*?min-height:\s*0/,
    );
    expect(graphCss).toMatch(
      /\.sh-graph-canvas__surface\s*\{[\s\S]*?height:\s*100%[\s\S]*?min-height:\s*0/,
    );
  });

  it("keeps the graph canvas bounded while collapsing its details column", () => {
    expect(graphCss).toMatch(
      /\.sh-graph__body\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 20rem[\s\S]*?min-width:\s*0/,
    );
    expect(graphCss).toMatch(
      /@media \(max-width:\s*60rem\)\s*\{[\s\S]*?\.sh-graph__body\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    expect(graphCss).toMatch(
      /\.sh-graph-canvas__surface\s*\{[\s\S]*?height:\s*100%[\s\S]*?min-height:\s*0[\s\S]*?overflow:\s*hidden/,
    );
  });

  it("allows the conflict workbench to shrink every compact-width column", () => {
    expect(decisionsCss).toMatch(
      /\.sh-conflict-page\s*\{[\s\S]*?min-width:\s*0/,
    );
    expect(decisionsCss).toMatch(
      /\.sh-conflict-workbench\s*\{[\s\S]*?align-items:\s*start/,
    );
    expect(decisionsCss).toMatch(
      /\.sh-conflict-actions\s*\{[\s\S]*?min-width:\s*0/,
    );
  });

  it("keeps the governance table inside its scrollable panel", () => {
    expect(governanceCss).toMatch(
      /\.sh-governance__list\s*\{[\s\S]*?max-height:\s*60vh[\s\S]*?overflow-x:\s*auto[\s\S]*?overflow-y:\s*auto/,
    );
  });
});
