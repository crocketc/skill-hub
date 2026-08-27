import { describe, expect, it } from "vitest";
import {
  createMockImportFacade,
  parseSourceInput,
  unavailableImportFacade,
} from "./api";

describe("ImportFacade contract", () => {
  it("parses npx text as a non-executable reference", async () => {
    const source = await parseSourceInput("npx skills add github:owner/repo");

    expect(source).toEqual(
      expect.objectContaining({
        kind: "npx_reference",
        displayTarget: "github:owner/repo",
        executesCommand: false,
      }),
    );
  });

  it("rejects acquisition and commit at the production boundary", async () => {
    const source = await unavailableImportFacade.parseSource("C:\\Skills\\pdf");

    await expect(unavailableImportFacade.acquireCandidates(source)).rejects.toThrow(
      "import is unavailable",
    );
    await expect(
      unavailableImportFacade.commitImport(
        { candidates: [], conflicts: [] },
        {},
      ),
    ).rejects.toThrow("import is unavailable");
  });

  it("returns deterministic Agent ownership and partial commit fixtures", async () => {
    const facade = createMockImportFacade({ scenario: "agent-owned-partial" });
    const source = await facade.parseSource("C:\\Agents\\codex\\skills");
    const candidates = await facade.acquireCandidates(source);
    const plan = await facade.analyzeConflicts(candidates);
    const results = await facade.commitImport(plan, {
      [candidates[0].id]: "takeover",
      [candidates[1].id]: "skip",
    });

    expect(candidates[0].ownership).toBe("agent_builtin");
    expect(results.map((result) => result.status)).toEqual([
      "succeeded",
      "skipped",
    ]);
  });
});
