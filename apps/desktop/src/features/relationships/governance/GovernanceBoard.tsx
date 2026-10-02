import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { RelationGovernanceRow } from "../../../api/bindings";
import { relationIdOf } from "./api";
import { projectGovernanceBoard, type GovernanceBoardColumn } from "./governanceProjection";
import {
  GovernanceRelationActions,
  GovernanceRelationBlockers,
  GovernanceRelationIdentity,
  GovernanceRelationImpact,
  GovernanceRelationSelection,
  GovernanceRelationSource,
  GovernanceRelationTarget,
  GovernanceRelationTargetSummary,
  GovernanceRelationVerificationLabel,
  type GovernanceRelationTableProps,
} from "./GovernanceRelationTable";

const BOARD_COLUMNS: readonly {
  key: GovernanceBoardColumn;
  labelKey: string;
  testId: string;
}[] = [
  {
    key: "manageable",
    labelKey: "relationships.governance.board.manageable",
    testId: "governance-board-column-manageable",
  },
  {
    key: "needsValidation",
    labelKey: "relationships.governance.board.needsValidation",
    testId: "governance-board-column-verification",
  },
  {
    key: "blocked",
    labelKey: "relationships.governance.board.blocked",
    testId: "governance-board-column-blocked",
  },
  {
    key: "settled",
    labelKey: "relationships.governance.board.settled",
    testId: "governance-board-column-settled",
  },
];

export interface GovernanceBoardProps extends GovernanceRelationTableProps {
  listRef?: RefObject<HTMLDivElement>;
  onListScroll?: () => void;
}

/**
 * One-card-per-edge board. It consumes the same presenters and action
 * availability as the dense table view; only the layout changes.
 */
export function GovernanceBoard({
  busyRelationIds,
  listRef,
  onCentralize,
  onClean,
  onListScroll,
  onRevalidate,
  onRetain,
  onToggleAll,
  onToggleRow,
  onUndeploy,
  rows,
  selectedIds,
}: GovernanceBoardProps) {
  const { t } = useTranslation();
  const projection = projectGovernanceBoard(rows);
  const selectableRows = rows.filter((row) => row.readiness !== "blocked" && row.status !== "blocked");
  const allSelectableChecked = selectableRows.length > 0
    && selectableRows.every((row) => selectedIds.has(relationIdOf(row.relation)));

  return (
    <div
      aria-label={t("relationships.governance.board.label")}
      className="sh-governance__list sh-governance__board-scroll"
      data-testid="governance-row-list"
      onScroll={onListScroll}
      ref={listRef}
    >
      <div className="sh-governance__board-selection">
        <input
          aria-label={t("relationships.governance.table.selectAll")}
          checked={allSelectableChecked}
          data-testid="governance-select-all"
          disabled={selectableRows.length === 0}
          onChange={(event) => onToggleAll(event.target.checked)}
          type="checkbox"
        />
        <span>{t("relationships.governance.table.selectAll")}</span>
      </div>
      <div className="sh-governance__board" data-testid="governance-board">
        {BOARD_COLUMNS.map(({ key, labelKey, testId }) => {
          const columnRows = projection[key];
          return (
            <section
              aria-labelledby={`${testId}-heading`}
              className={`sh-governance__board-column sh-governance__board-column--${key}`}
              data-testid={testId}
              key={key}
            >
              <h2 className="sh-governance__board-heading" id={`${testId}-heading`}>
                <span>{t(labelKey as never)}</span>
                <span
                  aria-label={String(t("relationships.governance.board.relationshipCount", {
                    count: columnRows.length,
                  }))}
                  className="sh-governance__board-count"
                  data-testid={`${testId}-count`}
                >
                  {columnRows.length}
                </span>
              </h2>
              {columnRows.length === 0 ? (
                <p className="sh-governance__board-empty">
                  {t("relationships.governance.board.emptyColumn")}
                </p>
              ) : (
                <ul className="sh-governance__board-cards">
                  {columnRows.map((row) => (
                    <GovernanceBoardCard
                      busy={busyRelationIds.has(relationIdOf(row.relation))}
                      key={relationIdOf(row.relation)}
                      onCentralize={onCentralize}
                      onClean={onClean}
                      onRevalidate={onRevalidate}
                      onRetain={onRetain}
                      onToggleRow={onToggleRow}
                      onUndeploy={onUndeploy}
                      row={row}
                      selected={selectedIds.has(relationIdOf(row.relation))}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function GovernanceBoardCard({
  busy,
  onCentralize,
  onClean,
  onRevalidate,
  onRetain,
  onToggleRow,
  onUndeploy,
  row,
  selected,
}: {
  busy: boolean;
  onCentralize: GovernanceRelationTableProps["onCentralize"];
  onClean: GovernanceRelationTableProps["onClean"];
  onRevalidate: GovernanceRelationTableProps["onRevalidate"];
  onRetain: GovernanceRelationTableProps["onRetain"];
  onToggleRow: GovernanceRelationTableProps["onToggleRow"];
  onUndeploy: GovernanceRelationTableProps["onUndeploy"];
  row: RelationGovernanceRow;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const relationId = relationIdOf(row.relation);
  return (
    <li className="sh-governance__board-card-wrap">
      <article className="sh-governance__board-card" data-testid="governance-row">
        <div className="sh-governance__board-card-heading">
          <GovernanceRelationSelection onToggleRow={onToggleRow} row={row} selected={selected} />
          <GovernanceRelationIdentity row={row} />
        </div>
        <div className="sh-governance__board-target">
          <span className="sh-governance__board-fact-label">
            {t("relationships.governance.table.target")}
          </span>
          <GovernanceRelationTargetSummary row={row} />
        </div>
        <div className="sh-governance__board-issue" data-testid={`governance-verification-${relationId}`}>
          <GovernanceRelationBlockers row={row} />
        </div>
        <details className="sh-governance__board-details" data-testid="governance-relation-details">
          <summary>{t("relationships.governance.board.relationInfo")}</summary>
          <div className="sh-governance__board-facts">
            <div className="sh-governance__board-fact" data-testid={`governance-source-${relationId}`}>
              <span className="sh-governance__board-fact-label">
                {t("relationships.governance.table.source")}
              </span>
              <GovernanceRelationSource row={row} />
            </div>
            <div className="sh-governance__board-fact sh-governance__board-target-full" data-testid={`governance-target-${relationId}`}>
              <span className="sh-governance__board-fact-label">
                {t("relationships.governance.table.target")}
              </span>
              <GovernanceRelationTarget row={row} />
            </div>
            <div className="sh-governance__board-fact" data-testid={`governance-impact-${relationId}`}>
              <span className="sh-governance__board-fact-label">
                {t("relationships.governance.table.impact")}
              </span>
              <GovernanceRelationImpact row={row} />
            </div>
            <div className="sh-governance__board-fact" data-testid={`governance-verification-fact-${relationId}`}>
              <span className="sh-governance__board-fact-label">
                {t("relationships.governance.table.verification")}
              </span>
              <GovernanceRelationVerificationLabel row={row} />
            </div>
          </div>
        </details>
        <div className="sh-governance__board-actions" data-testid={`governance-actions-${relationId}`}>
          <GovernanceRelationActions
            busy={busy}
            onCentralize={onCentralize}
            onClean={onClean}
            onRevalidate={onRevalidate}
            onRetain={onRetain}
            onUndeploy={onUndeploy}
            row={row}
          />
        </div>
      </article>
    </li>
  );
}
