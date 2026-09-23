import { afterEach, describe, expect, it } from "vitest";
import {
  clearRelationshipsReturnState,
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
});
