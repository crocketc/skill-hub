import { displayPath } from "../../../platform/displayPath";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type {
  RelationGovernanceBatchItem,
  RelationGovernanceBatchOutcome,
  RelationGovernanceRow,
} from "../../../api/bindings";
import { Button } from "../../../ui/Button";
import {
  batchItemStateLabelKey,
  batchResultTitleKey,
  relationIdOf,
  relationPathOf,
  rowIsNaturallyExecutable,
  rowNeedsSharedImpactConfirmation,
  summarizeBatchSelection,
} from "./api";

export interface GovernanceBatchDialogProps {
  /** 进入对话框的选中行：既包含可执行行，也包含选中但受阻的行。 */
  rows: readonly RelationGovernanceRow[];
  /** 逐项执行选择：受阻行不可勾选，默认不选中。 */
  checkedIds: ReadonlySet<string>;
  sharedConfirmedIds: ReadonlySet<string>;
  running: boolean;
  /** prepare/commit 被后端拒绝后的错误文本；预览保持不变。 */
  error: string | null;
  /** commit 完成后的批次结果；null 表示仍在预览/执行阶段。 */
  result: RelationGovernanceBatchOutcome | null;
  /** 批量清理的所有权确认（任务 11.15）：单一开关覆盖全部勾选行。 */
  ownershipConfirmed: boolean;
  onOwnershipConfirm: (checked: boolean) => void;
  onToggleItem: (relationId: string, checked: boolean) => void;
  onSharedImpactConfirm: (relationId: string, checked: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
  onRetry: (relationId: string) => void;
  onRollback: (relationId: string) => void;
}

/**
 * 批量治理对话框（任务 8）：预览（可执行/受阻摘要 + 逐项取消）→ 确认 →
 * 逐条执行并验证 → 逐项结果（成功/失败/取消/回退）。任何 partial 结果都
 * 逐项呈现并允许单项重试或回退，绝不汇总成“全部成功”。
 */
export function GovernanceBatchDialog({
  checkedIds,
  error,
  onClose,
  onConfirm,
  onOwnershipConfirm,
  onRetry,
  onRollback,
  onSharedImpactConfirm,
  onToggleItem,
  ownershipConfirmed,
  result,
  rows,
  running,
  sharedConfirmedIds,
}: GovernanceBatchDialogProps) {
  const { t } = useTranslation();
  // 任务 11.10/11.15：一个批次只做一件事、只处理一类关系边；勾选行一旦
  // 混类就拒绝收敛（确认禁用），受阻行单独分组、不可勾选。取消单项后
  // 批次按剩余勾选行重新收敛，其余行不受影响。
  const executableRows = rows.filter(rowIsNaturallyExecutable);
  const blockedRows = rows.filter((row) => !rowIsNaturallyExecutable(row));
  const checkedRows = executableRows.filter((row) => checkedIds.has(relationIdOf(row.relation)));
  const selection = summarizeBatchSelection(checkedRows);
  const isMixed = selection.kind === "mixed";
  const checkedCount = checkedRows.length;
  const missingSharedConfirmation = selection.kind === "deployment" && executableRows.some((row) => {
    const relationId = relationIdOf(row.relation);
    return rowNeedsSharedImpactConfirmation(row)
      && checkedIds.has(relationId)
      && !sharedConfirmedIds.has(relationId);
  });
  const needsOwnershipConfirmation = selection.kind === "source_copy";
  const confirmDisabled = running
    || isMixed
    || checkedCount === 0
    || missingSharedConfirmation
    || (needsOwnershipConfirmation && !ownershipConfirmed);

  return (
    <div aria-label={t("relationships.governance.batch.title")} className="sh-governance__dialog" data-testid="governance-batch-dialog" role="dialog">
      <h3>{t("relationships.governance.batch.title")}</h3>
      {result ? (
        <BatchResult
          onRetry={onRetry}
          onRollback={onRollback}
          result={result}
        />
      ) : (
        <>
          <p>{t("relationships.governance.batch.hint")}</p>
          {isMixed ? (
            <p data-testid="governance-batch-mixing" role="alert">
              {t("relationships.governance.batch.mixing")}
            </p>
          ) : null}
          {blockedRows.length > 0 ? (
            <p data-testid="governance-batch-blocked-summary">
              {t("relationships.governance.batchSummary.blocked", { count: blockedRows.length })}
            </p>
          ) : null}
          <ul className="sh-governance__batch-items">
            {executableRows.map((row) => {
              const relationId = relationIdOf(row.relation);
              const needsConfirmation = rowNeedsSharedImpactConfirmation(row);
              return (
                <li data-testid={`governance-batch-item-${relationId}`} key={relationId}>
                  <label>
                    <input
                      aria-label={t("relationships.governance.batch.itemCheck", { name: row.skill_display_name ?? t("relationshipGovernance.matrix.unknownSkill") })}
                      checked={checkedIds.has(relationId)}
                      data-testid={`governance-batch-check-${relationId}`}
                      disabled={running}
                      onChange={(event) => onToggleItem(relationId, event.target.checked)}
                      type="checkbox"
                    />
                    <span>{row.skill_display_name ?? t("relationshipGovernance.matrix.unknownSkill")}</span>
                    <span>{t("relationships.governance.batch.itemExecutable")}</span>
                  </label>
                  <span>{t("agents.pathLabel")} <code>{displayPath(relationPathOf(row.relation))}</code></span>
                  {needsConfirmation ? (
                    <label className="sh-governance__confirm-check">
                      <input
                        aria-label={t("relationships.governance.batch.sharedImpactConfirm", { name: row.skill_display_name ?? t("relationshipGovernance.matrix.unknownSkill") })}
                        checked={sharedConfirmedIds.has(relationId)}
                        disabled={running}
                        onChange={(event) => onSharedImpactConfirm(relationId, event.target.checked)}
                        type="checkbox"
                      />
                      {t("relationships.governance.preview.sharedImpactConfirm")}
                    </label>
                  ) : null}
                </li>
              );
            })}
            {blockedRows.map((row) => {
              const relationId = relationIdOf(row.relation);
              return (
                <li data-testid={`governance-batch-item-${relationId}`} key={relationId}>
                  <label>
                    <input
                      aria-label={t("relationships.governance.batch.itemCheck", { name: row.skill_display_name ?? t("relationshipGovernance.matrix.unknownSkill") })}
                      checked={false}
                      data-testid={`governance-batch-check-${relationId}`}
                      disabled
                      readOnly
                      type="checkbox"
                    />
                    <span>{row.skill_display_name ?? t("relationshipGovernance.matrix.unknownSkill")}</span>
                    <span>{t("relationships.governance.batch.itemBlocked")}</span>
                  </label>
                  <ul className="sh-governance__blockers">
                    {row.blockers.map((blocker) => (
                      <li key={blocker}>
                        {t(`relationships.governance.blockers.${blocker}` as never)}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          {needsOwnershipConfirmation && !isMixed ? (
            <label className="sh-governance__confirm-check">
              <input
                checked={ownershipConfirmed}
                data-testid="governance-batch-ownership"
                disabled={running}
                onChange={(event) => onOwnershipConfirm(event.target.checked)}
                type="checkbox"
              />
              {t("relationships.governance.clean.ownership")}
            </label>
          ) : null}
          {running ? (
            <p role="status">{t("relationships.governance.batch.running")}</p>
          ) : null}
          {error ? (
            <div role="alert">
              <p>{t("relationships.governance.preview.rejectedNote")}</p>
              <p>{error}</p>
            </div>
          ) : null}
          <div className="sh-governance__dialog-actions">
            <Button disabled={running} onClick={onClose} variant="secondary">
              {t("actions.cancel")}
            </Button>
            <Button data-testid="governance-batch-confirm" disabled={confirmDisabled} onClick={onConfirm}>
              {t("relationships.governance.batch.confirmCount", { count: checkedCount })}
            </Button>
          </div>
        </>
      )}
      {result ? (
        <div className="sh-governance__dialog-actions">
          <Button onClick={onClose} variant="secondary">
            {t("relationships.governance.batch.close")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** 批次结果（逐项终态 + 重试/回退）。单条纳入的结果面板复用同一套语义。 */
export function BatchResult({
  onRetry,
  onRollback,
  result,
}: {
  result: RelationGovernanceBatchOutcome;
  onRetry: (relationId: string) => void;
  onRollback: (relationId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid="governance-batch-result">
      <p data-testid="governance-batch-result-title">
        {t(batchResultTitleKey(result.state) as never, {
          committed: result.committed_count,
          count: result.committed_count,
          failed: result.failed_count,
        })}
      </p>
      <ul className="sh-governance__batch-items">
        {result.items.map((item) => (
          <BatchResultItem
            item={item}
            key={item.relation_id}
            onRetry={onRetry}
            onRollback={onRollback}
          />
        ))}
      </ul>
    </div>
  );
}

function BatchResultItem({
  item,
  onRetry,
  onRollback,
}: {
  item: RelationGovernanceBatchItem;
  onRetry: (relationId: string) => void;
  onRollback: (relationId: string) => void;
}) {
  const { t } = useTranslation();
  const relationId = item.relation_id;
  return (
    <li data-testid={`governance-batch-result-${relationId}`}>
      <span>{t("relationships.governance.batch.selectedRelationship")}</span>
      <span>{t(batchItemStateLabelKey(item.state) as never)}</span>
      {item.detail ? <span>{item.detail}</span> : null}
      {item.state === "committed" && item.rollback_available ? (
        <>
          <span>{t("relationships.governance.batch.rollbackAvailable")}</span>
          <Button
            data-testid={`governance-batch-rollback-${relationId}`}
            onClick={() => onRollback(relationId)}
            size="sm"
            variant="secondary"
          >
            {t("relationships.governance.batch.rollback", { id: relationId })}
          </Button>
        </>
      ) : null}
      {item.state === "failed" && item.retryable ? (
        <>
          {item.rollback_available ? (
            <span>{t("relationships.governance.batch.rollbackAvailable")}</span>
          ) : null}
          <Button
            data-testid={`governance-batch-retry-${relationId}`}
            onClick={() => onRetry(relationId)}
            size="sm"
          >
            {t("relationships.governance.batch.retry", { id: relationId })}
          </Button>
        </>
      ) : null}
      {item.operation_id ? (
        <Link data-testid={`governance-batch-operation-${relationId}`} to={`/operations/${item.operation_id}`}>
          {t("relationships.governance.batch.childOperation")}
        </Link>
      ) : null}
    </li>
  );
}
