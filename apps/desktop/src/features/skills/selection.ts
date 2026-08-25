import type { BatchTarget, SkillFilterSnapshot } from "./api";

export type SkillSelection =
  | { kind: "none" }
  | { kind: "explicit"; skillIds: string[] }
  | {
      kind: "all_filtered";
      excludedSkillIds: string[];
      filter: SkillFilterSnapshot;
      filterKey: string;
      total: number;
    };

function normalizeIds(skillIds: string[]): string[] {
  return [...new Set(skillIds)].sort();
}

function cloneFilterSnapshot(filter: SkillFilterSnapshot): SkillFilterSnapshot {
  return {
    filters: {
      aiCheck: [...filter.filters.aiCheck],
      basicCheck: [...filter.filters.basicCheck],
      deployment: filter.filters.deployment,
      lifecycle: [...filter.filters.lifecycle],
      tags: [...filter.filters.tags],
      version: filter.filters.version,
    },
    text: filter.text,
  };
}

export function selectExplicit(
  state: SkillSelection,
  skillIds: string[],
  selected: boolean,
): SkillSelection {
  const currentSkillIds = state.kind === "explicit" ? state.skillIds : [];
  const nextSkillIds = selected
    ? normalizeIds([...currentSkillIds, ...skillIds])
    : normalizeIds(currentSkillIds.filter((skillId) => !skillIds.includes(skillId)));

  return nextSkillIds.length === 0 ? { kind: "none" } : { kind: "explicit", skillIds: nextSkillIds };
}

export function selectAllFiltered(
  filter: SkillFilterSnapshot,
  filterKey: string,
  total: number,
): Extract<SkillSelection, { kind: "all_filtered" }> {
  return { excludedSkillIds: [], filter: cloneFilterSnapshot(filter), filterKey, kind: "all_filtered", total };
}

export function excludeFromAllFiltered(
  state: Extract<SkillSelection, { kind: "all_filtered" }>,
  skillId: string,
  excluded: boolean,
): Extract<SkillSelection, { kind: "all_filtered" }> {
  const excludedSkillIds = excluded
    ? normalizeIds([...state.excludedSkillIds, skillId])
    : normalizeIds(state.excludedSkillIds.filter((id) => id !== skillId));

  return { ...state, excludedSkillIds, filter: cloneFilterSnapshot(state.filter) };
}

export function retainExplicitSelection(state: SkillSelection, matchingIds: string[]): SkillSelection {
  if (state.kind !== "explicit") {
    return state;
  }

  const matching = new Set(matchingIds);
  const skillIds = normalizeIds(state.skillIds.filter((skillId) => matching.has(skillId)));
  return skillIds.length === 0 ? { kind: "none" } : { kind: "explicit", skillIds };
}

export function selectionCount(state: SkillSelection): number {
  if (state.kind === "none") {
    return 0;
  }

  if (state.kind === "explicit") {
    return normalizeIds(state.skillIds).length;
  }

  return state.total - normalizeIds(state.excludedSkillIds).length;
}

export function selectionToBatchTarget(
  state: Exclude<SkillSelection, { kind: "none" }>,
): BatchTarget {
  if (state.kind === "explicit") {
    return { kind: "skill_ids", skillIds: normalizeIds(state.skillIds) };
  }

  return {
    excludedSkillIds: normalizeIds(state.excludedSkillIds),
    filter: cloneFilterSnapshot(state.filter),
    kind: "filtered",
  };
}
