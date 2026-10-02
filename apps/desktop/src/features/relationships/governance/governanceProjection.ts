import type { RelationGovernanceRow } from "../../../api/bindings";

export type GovernanceBoardColumn = "manageable" | "needsValidation" | "blocked" | "settled";

export interface GovernanceBoardProjection {
  manageable: RelationGovernanceRow[];
  needsValidation: RelationGovernanceRow[];
  blocked: RelationGovernanceRow[];
  settled: RelationGovernanceRow[];
}

/**
 * Projects each current relationship edge into exactly one board column.
 * Safety and unresolved evidence always outrank readiness so attention items
 * can never be presented as settled just because their relation is managed.
 */
export function projectGovernanceBoard(
  rows: readonly RelationGovernanceRow[],
): GovernanceBoardProjection {
  const projection: GovernanceBoardProjection = {
    manageable: [],
    needsValidation: [],
    blocked: [],
    settled: [],
  };

  for (const row of rows) {
    const column = governanceBoardColumnOf(row);
    projection[column].push(row);
  }

  return projection;
}

export function governanceBoardColumnOf(row: RelationGovernanceRow): GovernanceBoardColumn {
  if (row.readiness === "blocked" || row.status === "blocked") return "blocked";
  if (
    row.readiness === "needs_validation"
    || row.status === "needs_validation"
    || row.status === "needs_attention"
  ) return "needsValidation";
  if (row.readiness === "eligible_to_centralize") return "manageable";
  return "settled";
}
