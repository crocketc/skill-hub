import type { RelationGovernanceRow } from "../../../api/bindings";

export type GovernanceBoardColumn = RelationGovernanceRow["governance"]["governance_status"];

export interface GovernanceBoardProjection {
  pending: RelationGovernanceRow[];
  completed: RelationGovernanceRow[];
}

/**
 * Projects each current relationship into exactly one authoritative
 * governance column. Health, readiness, and management are independent facts;
 * only the backend governance classification decides this grouping.
 */
export function projectGovernanceBoard(
  rows: readonly RelationGovernanceRow[],
): GovernanceBoardProjection {
  const projection: GovernanceBoardProjection = {
    pending: [],
    completed: [],
  };

  for (const row of rows) {
    const column = governanceBoardColumnOf(row);
    projection[column].push(row);
  }

  return projection;
}

export function governanceBoardColumnOf(row: RelationGovernanceRow): GovernanceBoardColumn {
  return row.governance.governance_status;
}
