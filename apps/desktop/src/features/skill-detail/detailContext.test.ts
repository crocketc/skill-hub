import { describe, expect, it } from "vitest";
import {
  detailSearchFromLibrary,
  readLibraryReturnState,
} from "./detailContext";

describe("Skill detail route context", () => {
  it("preserves library query state while removing the drawer-only Skill", () => {
    expect(
      detailSearchFromLibrary(
        "?q=pdf&page=2&view=attention&skill=skill-pdf",
      ),
    ).toBe("?q=pdf&page=2&view=attention");
  });

  it("accepts only complete finite library return state", () => {
    expect(
      readLibraryReturnState({
        libraryReturn: {
          focusSkillId: "skill-pdf",
          scrollLeft: 8,
          scrollTop: 416,
        },
      }),
    ).toEqual({
      focusSkillId: "skill-pdf",
      scrollLeft: 8,
      scrollTop: 416,
    });
    expect(
      readLibraryReturnState({
        libraryReturn: { focusSkillId: "skill-pdf", scrollTop: 416 },
      }),
    ).toBeUndefined();
  });
});
