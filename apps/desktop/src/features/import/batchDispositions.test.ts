import { describe, expect, it } from "vitest";
import type { ImportBatchAnalysis, ImportConflict } from "./api";
import {
  batchSuggestionActions,
  pendingBatchDispositionIds,
} from "./batchDispositions";
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

describe("pending batch dispositions", () => {
  it("treats every same-name member as pending before any decision", () => {
    expect(
      pendingBatchDispositionIds(batch, {}),
    ).toEqual(["alpha-a", "alpha-b"]);
  });

  it("accepts skip or independent import as a disposition without renaming", () => {
    expect(
      pendingBatchDispositionIds(
        batch,
        { "alpha-a": "independent", "alpha-b": "skip" },
      ),
    ).toEqual([]);
  });

  it("treats actions outside skip/independent as undecided for batch members", () => {
    expect(
      pendingBatchDispositionIds(
        batch,
        { "alpha-a": "copy", "alpha-b": "skip" },
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
