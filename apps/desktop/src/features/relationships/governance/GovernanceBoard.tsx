import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RelationGovernanceRow } from "../../../api/bindings";
import { relationIdOf, rowIsNaturallyExecutable } from "./api";
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
    key: "pending",
    labelKey: "relationships.governance.classification.pending",
    testId: "governance-board-column-pending",
  },
  {
    key: "completed",
    labelKey: "relationships.governance.classification.completed",
    testId: "governance-board-column-completed",
  },
];

export interface GovernanceBoardProps extends Omit<GovernanceRelationTableProps, "listRef" | "onListScroll"> {
  scrollResetKey?: string;
}

/**
 * One-card-per-edge board. It consumes the same presenters and action
 * availability as the dense table view; only the layout changes.
 */
export function GovernanceBoard({
  busyRelationIds,
  onCentralize,
  onEndRelationship,
  onRevalidate,
  onRetain,
  onRevokeRetention,
  onToggleAll,
  onToggleRow,
  onUndeploy,
  rows,
  scrollResetKey = "",
  selectedIds,
}: GovernanceBoardProps) {
  const { t } = useTranslation();
  const projection = projectGovernanceBoard(rows);
  const selectableRows = rows.filter(rowIsNaturallyExecutable);
  const allSelectableChecked = selectableRows.length > 0
    && selectableRows.every((row) => selectedIds.has(relationIdOf(row.relation)));

  return (
    <div
      aria-label={t("relationships.governance.board.label")}
      className="sh-governance__list sh-governance__board-scroll"
      data-testid="governance-row-list"
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
        {BOARD_COLUMNS
          .map((column, order) => ({ ...column, order, count: projection[column.key].length }))
          .sort((left, right) => right.count - left.count || left.order - right.order)
          .map(({ key, labelKey, testId }) => (
            <GovernanceBoardColumnView
              busyRelationIds={busyRelationIds}
              column={key}
              key={key}
              labelKey={labelKey}
              onCentralize={onCentralize}
              onEndRelationship={onEndRelationship}
              onRevalidate={onRevalidate}
              onRetain={onRetain}
              onRevokeRetention={onRevokeRetention}
              onToggleRow={onToggleRow}
              onUndeploy={onUndeploy}
              rows={projection[key]}
              scrollResetKey={scrollResetKey}
              selectedIds={selectedIds}
              testId={testId}
            />
          ))}
      </div>
    </div>
  );
}

function GovernanceBoardColumnView({
  busyRelationIds,
  column,
  labelKey,
  onCentralize,
  onEndRelationship,
  onRevalidate,
  onRetain,
  onRevokeRetention,
  onToggleRow,
  onUndeploy,
  rows,
  scrollResetKey,
  selectedIds,
  testId,
}: {
  busyRelationIds: ReadonlySet<string>;
  column: GovernanceBoardColumn;
  labelKey: string;
  onCentralize: GovernanceRelationTableProps["onCentralize"];
  onEndRelationship: GovernanceRelationTableProps["onEndRelationship"];
  onRevalidate: GovernanceRelationTableProps["onRevalidate"];
  onRetain: GovernanceRelationTableProps["onRetain"];
  onRevokeRetention: GovernanceRelationTableProps["onRevokeRetention"];
  onToggleRow: GovernanceRelationTableProps["onToggleRow"];
  onUndeploy: GovernanceRelationTableProps["onUndeploy"];
  rows: readonly RelationGovernanceRow[];
  scrollResetKey: string;
  selectedIds: ReadonlySet<string>;
  testId: string;
}) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const columnLabel = String(t(labelKey as never));
  const scrollRegionLabel = String(t("relationships.governance.board.columnScrollRegion", {
    count: rows.length,
    label: columnLabel,
  }));
  const scrollToTopLabel = String(t("relationships.governance.board.scrollToTop", {
    label: columnLabel,
  }));

  useEffect(() => {
    const body = bodyRef.current;
    if (body && body.scrollTop > 0) body.scrollTop = 0;
    setAtTop(true);
  }, [scrollResetKey]);

  const handleBodyScroll = useCallback(() => {
    setAtTop((current) => {
      const next = (bodyRef.current?.scrollTop ?? 0) <= 0;
      return current === next ? current : next;
    });
  }, []);

  const scrollToTop = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    body.scrollTo({ behavior: reduceMotion ? "auto" : "smooth", top: 0 });
  }, []);

  return (
    <section
      aria-labelledby={`${testId}-heading`}
      className={`sh-governance__board-column sh-governance__board-column--${column}`}
      data-testid={testId}
      key={column}
    >
      <div className="sh-governance__board-heading">
        <h2 className="sh-governance__board-heading-title" id={`${testId}-heading`}>
          <span className="sh-governance__board-heading-label">{columnLabel}</span>
          <span
            aria-label={String(t("relationships.governance.board.relationshipCount", {
              count: rows.length,
            }))}
            className="sh-governance__board-count"
            data-testid={`${testId}-count`}
          >
            {rows.length}
          </span>
        </h2>
        <button
          aria-label={scrollToTopLabel}
          className="sh-governance__board-scroll-top"
          data-testid={`governance-board-scroll-top-${column}`}
          disabled={atTop}
          onClick={scrollToTop}
          title={scrollToTopLabel}
          type="button"
        >
          <RocketUpIcon />
        </button>
      </div>
      <div
        aria-label={scrollRegionLabel}
        className="sh-governance__board-column-body"
        data-testid={`governance-board-column-body-${column}`}
        onScroll={handleBodyScroll}
        ref={bodyRef}
        role="region"
        tabIndex={0}
      >
        {rows.length === 0 ? (
          <p className="sh-governance__board-empty">
            {t("relationships.governance.board.emptyColumn")}
          </p>
        ) : (
          <ul className="sh-governance__board-cards">
            {rows.map((row) => (
              <GovernanceBoardCard
                busy={busyRelationIds.has(relationIdOf(row.relation))}
                key={relationIdOf(row.relation)}
                onCentralize={onCentralize}
                onEndRelationship={onEndRelationship}
                onRevalidate={onRevalidate}
                onRetain={onRetain}
                onRevokeRetention={onRevokeRetention}
                onToggleRow={onToggleRow}
                onUndeploy={onUndeploy}
                row={row}
                selected={selectedIds.has(relationIdOf(row.relation))}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function RocketUpIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="19" viewBox="0 0 24 24" width="19">
      <path d="M14.1 4.1c2.1-1.6 4.8-1.8 6.4-1.8 0 1.6-.2 4.3-1.8 6.4-1 1.3-2.4 2.8-4.1 4L10.1 8.2c1.2-1.7 2.7-3.1 4-4.1Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="m10.2 8.1-3.8.8-2.2 2.2 5.2.8m4.6-4.6-.8 3.8-2.2 2.2-.8-5.2M8.6 15.2l-2.8 2.8m.7-3.5-2.1 2.1m5 1.4-2.1 2.1M14.8 5.1l.1.1" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
      <circle cx="16.3" cy="6.5" r="1.1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 21v-4m-2 2 2-2 2 2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

function GovernanceBoardCard({
  busy,
  onCentralize,
  onEndRelationship,
  onRevalidate,
  onRetain,
  onRevokeRetention,
  onToggleRow,
  onUndeploy,
  row,
  selected,
}: {
  busy: boolean;
  onCentralize: GovernanceRelationTableProps["onCentralize"];
  onEndRelationship: GovernanceRelationTableProps["onEndRelationship"];
  onRevalidate: GovernanceRelationTableProps["onRevalidate"];
  onRetain: GovernanceRelationTableProps["onRetain"];
  onRevokeRetention: GovernanceRelationTableProps["onRevokeRetention"];
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
            onEndRelationship={onEndRelationship}
            onRevalidate={onRevalidate}
            onRetain={onRetain}
            onRevokeRetention={onRevokeRetention}
            onUndeploy={onUndeploy}
            row={row}
          />
        </div>
      </article>
    </li>
  );
}
