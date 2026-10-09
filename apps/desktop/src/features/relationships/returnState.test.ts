import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentProblemAnalysis } from "../../api/bindings";
import {
  clearRelationshipsReturnState,
  buildUsageGovernanceHref,
  parseUsageGovernanceContext,
  resolveUsageGovernanceProblem,
  readRelationshipsReturnState,
  relationshipsReturnStateEntryKey,
  relationshipsReturnStateStorageKey,
  saveRelationshipsReturnState,
} from "./returnState";

afterEach(() => {
  sessionStorage.clear();
});

describe("relationships return state", () => {
  it("uses a stable Skill key for graph state while other pages stay history-scoped", () => {
    expect(relationshipsReturnStateEntryKey("graph", "entry-a", "skill-pdf")).toBe("skill:skill-pdf");
    expect(relationshipsReturnStateEntryKey("governance", "entry-a", "skill-pdf")).toBe("entry-a");
  });

  it("round-trips non-URL view state under a namespaced, entry-scoped key", () => {
    const state = {
      filters: { center: "pdf-reader" },
      viewport: { x: 1, y: 2, zoom: 3 },
      scrollY: 480,
      selectedId: "edge-7",
    };

    saveRelationshipsReturnState("graph", "entry-a", state);

    expect(relationshipsReturnStateStorageKey("graph", "entry-a")).toBe(
      "skillhub:relationships:return-state:graph:entry-a",
    );
    expect(readRelationshipsReturnState("graph", "entry-a")).toEqual(state);
  });

  it("never bleeds between sources (scopes) or history entries", () => {
    saveRelationshipsReturnState("graph", "entry-a", {
      filters: { center: "pdf-reader" },
      viewport: { x: 0, y: 0, zoom: 2 },
    });

    expect(readRelationshipsReturnState("governance", "entry-a")).toBeNull();
    expect(readRelationshipsReturnState("decisions", "entry-a")).toBeNull();
    expect(readRelationshipsReturnState("graph", "entry-b")).toBeNull();
  });

  it("treats corrupt payloads as absent and supports explicit clearing", () => {
    sessionStorage.setItem(
      "skillhub:relationships:return-state:decisions:e1",
      "{not json",
    );
    expect(readRelationshipsReturnState("decisions", "e1")).toBeNull();

    saveRelationshipsReturnState("decisions", "e1", {
      filters: { category: "uncertain" },
    });
    clearRelationshipsReturnState("decisions", "e1");
    expect(readRelationshipsReturnState("decisions", "e1")).toBeNull();
  });

  it("round-trips the complete usage governance context through a safe deep link", () => {
    const href = buildUsageGovernanceHref({
      agent_id: "agent:codex",
      project_id: "project:one",
      problem_id: "env:same_skill:abc",
      relation_id: "managed:dep-1",
      skill_id: "skill:pdf",
      return_to: "/pending?category=relationships",
    });

    expect(href).toBe(
      "/relationships/governance?agent_id=agent%3Acodex&project_id=project%3Aone&problem_id=env%3Asame_skill%3Aabc&relation_id=managed%3Adep-1&skill_id=skill%3Apdf&return_to=%2Fpending%3Fcategory%3Drelationships",
    );
    expect(parseUsageGovernanceContext(new URLSearchParams(href!.split("?")[1]))).toEqual({
      agent_id: "agent:codex",
      project_id: "project:one",
      problem_id: "env:same_skill:abc",
      relation_id: "managed:dep-1",
      skill_id: "skill:pdf",
      return_to: "/pending?category=relationships",
    });
  });

  it("rejects missing Agent context and drops an unsafe return target", () => {
    expect(buildUsageGovernanceHref({ agent_id: "   " })).toBeNull();
    expect(parseUsageGovernanceContext(new URLSearchParams("problem_id=env%3A1"))).toBeNull();
    expect(parseUsageGovernanceContext(new URLSearchParams(
      "agent_id=codex&return_to=%2F%2Fevil.example",
    ))).toEqual({ agent_id: "codex" });
  });

  it("rejects a pending return context when its problem identity is missing", () => {
    expect(parseUsageGovernanceContext(new URLSearchParams(
      "agent_id=codex&return_to=%2Fpending%3Fcategory%3Drelationships",
    ))).toBeNull();
    expect(buildUsageGovernanceHref({
      agent_id: "codex",
      return_to: "/pending?category=relationships",
    })).toBeNull();
  });

  it("reloads the full current problem and rejects stale or changed anchor scope", () => {
    const context = { agent_id: "agent-a", project_id: "project-a", problem_id: "problem-a" };
    const problem: EnvironmentProblemAnalysis["problems"][number] = {
      problem_id: "problem-a",
      kind: "same_skill",
      entries: [],
      consumers: [
        { agent_client_id: "agent-a", project_id: "project-a" },
        { agent_client_id: "agent-b", project_id: null },
      ],
      environment_results: [],
      closed: false,
    };

    expect(resolveUsageGovernanceProblem(context, { problems: [problem], probe_limitations: [] })).toMatchObject({
      status: "active",
      problem: { problem_id: "problem-a", consumers: [{ agent_client_id: "agent-a" }, { agent_client_id: "agent-b" }] },
    });
    expect(resolveUsageGovernanceProblem(context, { problems: [], probe_limitations: [] })).toEqual({ status: "stale" });
    expect(resolveUsageGovernanceProblem(
      { ...context, agent_id: "agent-removed" },
      { problems: [problem], probe_limitations: [] },
    )).toEqual({ status: "scope_changed" });
  });
});
