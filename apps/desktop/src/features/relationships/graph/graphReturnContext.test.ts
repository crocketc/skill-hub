import { describe, expect, it } from "vitest";
import type { SkillLibraryReturnState } from "../../skill-detail/detailContext";
import {
  createDetailGraphReturnContext,
  createDrawerGraphReturnContext,
  readGraphReturnTarget,
  resolveGraphReturnHistoryDelta,
} from "./graphReturnContext";

const NOW = 1_800_000_000_000;
const libraryReturn: SkillLibraryReturnState = {
  focusSkillId: "skill-pdf",
  scrollLeft: 12,
  scrollTop: 416,
};

describe("graph source return context", () => {
  it("restores the filtered library with the drawer reopened", () => {
    const context = createDrawerGraphReturnContext({
      libraryReturn,
      now: NOW,
      pathname: "/library",
      search: "?q=pdf&tag=documents&page=2&skill=skill-pdf",
      skillId: "skill-pdf",
    });

    expect(context).toMatchObject({
      kind: "drawer",
      skillId: "skill-pdf",
      version: 1,
    });
    expect(readGraphReturnTarget({ graphSource: context }, NOW)).toEqual({
      kind: "drawer",
      to: "/library?tag=documents&q=pdf&page=2&skill=skill-pdf",
      state: { libraryReturn },
    });
  });

  it("restores the exact detail route and its validated library scroll context", () => {
    const context = createDetailGraphReturnContext({
      hash: "#review-usage",
      now: NOW,
      pathname: "/library/skill-pdf",
      search: "?tag=documents&text=pdf",
      skillId: "skill-pdf",
      state: { libraryReturn },
    });

    expect(readGraphReturnTarget({ graphSource: context }, NOW)).toEqual({
      kind: "detail",
      to: "/library/skill-pdf?tag=documents&text=pdf#review-usage",
      state: { libraryReturn },
    });
  });

  it("carries the source history index so graph return can restore the original entry", () => {
    const context = createDetailGraphReturnContext({
      now: NOW,
      pathname: "/library/skill-pdf",
      search: "?q=pdf",
      skillId: "skill-pdf",
      sourceHistoryIndex: 3,
      state: null,
    });

    expect(readGraphReturnTarget({ graphSource: context }, NOW)?.sourceHistoryIndex).toBe(3);
  });

  it("pops every intervening graph history entry to the source", () => {
    expect(resolveGraphReturnHistoryDelta(2, 5)).toBe(-3);
    expect(resolveGraphReturnHistoryDelta(undefined, 5)).toBeUndefined();
    expect(resolveGraphReturnHistoryDelta(5, 5)).toBeUndefined();
    expect(resolveGraphReturnHistoryDelta(6, 5)).toBeUndefined();
  });

  it("rejects mismatched, expired, malformed and external source routes", () => {
    const context = createDrawerGraphReturnContext({
      now: NOW,
      pathname: "/library",
      search: "?skill=skill-pdf",
      skillId: "skill-pdf",
    });
    expect(readGraphReturnTarget({ graphSource: { ...context, returnTo: "/library?skill=other-skill" } }, NOW)).toBeUndefined();
    expect(readGraphReturnTarget({ graphSource: { ...context, issuedAt: NOW - 31 * 60_000 } }, NOW)).toBeUndefined();
    expect(readGraphReturnTarget({ graphSource: { ...context, returnTo: "https://evil.example/" } }, NOW)).toBeUndefined();
    expect(readGraphReturnTarget({ graphSource: { ...context, returnTo: "/library/other-skill" } }, NOW)).toBeUndefined();
    expect(readGraphReturnTarget({ graphSource: { ...context, returnTo: "//evil.example/library" } }, NOW)).toBeUndefined();
    expect(readGraphReturnTarget({ graphSource: { ...context, sourceHistoryIndex: -1 } }, NOW)).toBeUndefined();
  });

  it("rejects unsupported source paths and unsafe detail anchors", () => {
    expect(createDrawerGraphReturnContext({
      now: NOW,
      pathname: "/external",
      search: "?skill=skill-pdf",
      skillId: "skill-pdf",
    })).toBeUndefined();
    expect(createDetailGraphReturnContext({
      hash: "#not-a-detail-section",
      now: NOW,
      pathname: "/library/skill-pdf",
      search: "",
      skillId: "skill-pdf",
      state: null,
    })?.returnTo).toBe("/library/skill-pdf");
  });

  it("returns no target when no source state is present", () => {
    expect(readGraphReturnTarget(null, NOW)).toBeUndefined();
  });
});
