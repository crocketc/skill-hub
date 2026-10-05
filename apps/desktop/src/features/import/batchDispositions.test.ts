import { describe, expect, it } from "vitest";
import type { ImportBatchAnalysis, ImportCandidate, ImportConflict } from "./api";
import {
  batchSuggestionActions,
  overrideNameCollision,
  pendingBatchDispositionIds,
} from "./batchDispositions";
import { parseSourceInput } from "./api";

const source = await parseSourceInput("C:/incoming");

function candidate(id: string, name: string, path = `C:/incoming/${id}`): ImportCandidate {
  return {
    basicCheck: "passed",
    id,
    name,
    ownership: "unknown",
    path,
    relativeRoot: id,
    source,
  };
}

const batchCandidates: ImportCandidate[] = [
  candidate("notes-a", "Notes Sync"),
  candidate("notes-b", "Notes Sync", "C:/incoming/backup/notes-sync"),
  candidate("alpha-a", "Alpha"),
  candidate("alpha-b", "Alpha", "C:/claude/skills/alpha-a"),
];

const batch: ImportBatchAnalysis = {
  sameContentGroups: [
    {
      keepCandidateId: "notes-a",
      normalizedRuntimeName: "notes sync",
      skipCandidateIds: ["notes-b"],
    },
  ],
  sameNameGroups: [
    { candidateIds: ["alpha-a", "alpha-b"], normalizedRuntimeName: "alpha" },
  ],
  signature: "sig-1",
};

/** alpha-a 的库内同名冲突：展示的库内 runtime 名进入即时重名校验。 */
const libraryConflict: ImportConflict = {
  candidateId: "alpha-a",
  kind: "same_name",
  matchedSkills: [
    { displayName: "Library Alpha", id: "lib-1", runtimeName: "Library Alpha" },
  ],
  summary: "import.same_runtime_name_conflict",
  allowedActions: ["independent", "skip"],
  required: true,
};

function overrideInput(value: string, overrides: Record<string, string> = {}) {
  return {
    candidateId: "alpha-a",
    groupCandidateIds: ["alpha-a", "alpha-b"],
    normalizedGroupName: "alpha",
    candidateNames: Object.fromEntries(
      batchCandidates.map((candidate) => [candidate.id, candidate.name]),
    ),
    libraryRuntimeNames: ["Library Alpha"],
    overrides,
    value,
  };
}

describe("batch independent rename validation", () => {
  it("rejects an empty override name", () => {
    expect(overrideNameCollision(overrideInput(""))).toBe("empty");
    expect(overrideNameCollision(overrideInput("   "))).toBe("empty");
  });

  it("rejects names colliding with the batch group name", () => {
    expect(overrideNameCollision(overrideInput("Alpha"))).toBe("batch");
  });

  it("rejects names colliding with another batch candidate's discovered name", () => {
    expect(overrideNameCollision(overrideInput("Notes Sync"))).toBe("batch");
  });

  it("rejects names colliding with a sibling's pending override", () => {
    expect(
      overrideNameCollision(
        overrideInput("Alpha Two", { "alpha-b": "Alpha Two" }),
      ),
    ).toBe("batch");
  });

  it("compares normalized names: case and surrounding whitespace folded", () => {
    expect(overrideNameCollision(overrideInput(" ALPHA "))).toBe("batch");
    expect(
      overrideNameCollision(overrideInput("library alpha")),
    ).toBe("library");
  });

  it("rejects names colliding with a shown library conflict runtime name", () => {
    expect(overrideNameCollision(overrideInput("Library Alpha"))).toBe(
      "library",
    );
  });

  it("accepts a fresh name that collides with nothing", () => {
    expect(overrideNameCollision(overrideInput("Alpha Prime"))).toBeNull();
  });
});

describe("pending batch dispositions", () => {
  it("treats every same-name member as pending before any decision", () => {
    expect(
      pendingBatchDispositionIds(batch, [libraryConflict], batchCandidates, {}, {}),
    ).toEqual(["alpha-a", "alpha-b"]);
  });

  it("accepts skip or a valid independent rename as a disposition", () => {
    expect(
      pendingBatchDispositionIds(
        batch,
        [libraryConflict],
        batchCandidates,
        { "alpha-a": "independent", "alpha-b": "skip" },
        { "alpha-a": "Alpha Prime" },
      ),
    ).toEqual([]);
  });

  it("keeps independent members pending until the rename is valid", () => {
    // 未填名。
    expect(
      pendingBatchDispositionIds(
        batch,
        [libraryConflict],
        batchCandidates,
        { "alpha-a": "independent", "alpha-b": "skip" },
        {},
      ),
    ).toEqual(["alpha-a"]);
    // 与库内展示的冲突名撞名。
    expect(
      pendingBatchDispositionIds(
        batch,
        [libraryConflict],
        batchCandidates,
        { "alpha-a": "independent", "alpha-b": "skip" },
        { "alpha-a": "Library Alpha" },
      ),
    ).toEqual(["alpha-a"]);
    // 批内撞名。
    expect(
      pendingBatchDispositionIds(
        batch,
        [libraryConflict],
        batchCandidates,
        { "alpha-a": "independent", "alpha-b": "independent" },
        { "alpha-a": "Alpha Prime", "alpha-b": "alpha prime" },
      ),
    ).toEqual(["alpha-b"]);
  });

  it("treats actions outside skip/independent as undecided for batch members", () => {
    expect(
      pendingBatchDispositionIds(
        batch,
        [libraryConflict],
        batchCandidates,
        { "alpha-a": "copy", "alpha-b": "skip" },
        {},
      ),
    ).toEqual(["alpha-a"]);
  });
});

describe("batch merge suggestions", () => {
  it("seeds keep=copy and the rest=skip without touching same-name members", () => {
    expect(batchSuggestionActions(batch, [])).toEqual({
      "notes-a": "copy",
      "notes-b": "skip",
    });
  });

  it("does not seed a keep candidate that still owes a library decision", () => {
    const conflictedBatch: ImportBatchAnalysis = {
      sameContentGroups: [
        {
          keepCandidateId: "notes-a",
          normalizedRuntimeName: "notes sync",
          skipCandidateIds: ["notes-b"],
        },
      ],
      sameNameGroups: [],
      signature: "sig-1",
    };
    const libraryDuplicate: ImportConflict = {
      candidateId: "notes-a",
      kind: "exact_duplicate",
      summary: "import.exact_content_conflict",
      allowedActions: ["reuse", "skip"],
      required: true,
    };
    expect(
      batchSuggestionActions(conflictedBatch, [libraryDuplicate]),
    ).toEqual({ "notes-b": "skip" });
  });
});
