import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CommitUsageChange,
  PrepareUsageChange,
  PreparedUsageChange,
  RelationGovernanceRow,
  UsageChangeResult,
  UsageContentBasis,
  UsageForm,
} from "../../../api/bindings";
import { describeNativeError } from "../../../api/nativeErrors";
import { displayPath } from "../../../platform/displayPath";
import { Button } from "../../../ui/Button";
import { RelationshipRemovalImpactView } from "../../relationshipGovernance/RelationshipRemovalImpactView";
import {
  relationIdOf,
  rowIsBatchExecutable,
  rowNeedsSharedImpactConfirmation,
  summarizeBatchSelection,
} from "./api";
import { governanceSkillDisplayName } from "./GovernanceRelationTable";

export interface UsageManageDialogProps {
  rows: readonly RelationGovernanceRow[];
  checkedIds: ReadonlySet<string>;
  sharedConfirmedIds: ReadonlySet<string>;
  allowSelection?: boolean;
  onToggleItem?: (relationId: string, checked: boolean) => void;
  onSharedImpactConfirm?: (relationId: string, checked: boolean) => void;
  onPrepare: (request: PrepareUsageChange) => Promise<PreparedUsageChange>;
  onCommit: (request: CommitUsageChange) => Promise<UsageChangeResult>;
  onBusyChange?: (busy: boolean) => void;
  onClose: () => void;
}

function newOperationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `usage-manage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function targetLabel(target: UsageChangeResult["item_results"][number]["target"], t: (key: string) => string) {
  switch (target.kind) {
    case "agent": return t("undeploy.flow.groups.agent");
    case "shared_directory": return t("undeploy.flow.groups.shared");
    case "project": return t("undeploy.flow.groups.project");
  }
}

/** Single and batch relationship conversion share the same frozen prepare/commit flow. */
export function UsageManageDialog({
  allowSelection = false,
  checkedIds,
  onBusyChange,
  onClose,
  onCommit,
  onPrepare,
  onSharedImpactConfirm,
  onToggleItem,
  rows,
  sharedConfirmedIds,
}: UsageManageDialogProps) {
  const { t } = useTranslation();
  const describeError = (reason: unknown) => describeNativeError(
    reason,
    (key, options) => String(t(key as never, options as never)),
    "tasks.notices.failureUnknown",
  );
  const [contentBasis, setContentBasis] = useState<UsageContentBasis>("library_current");
  const [requestedForm, setRequestedForm] = useState<UsageForm>("link");
  const [prepared, setPrepared] = useState<PreparedUsageChange | null>(null);
  const [result, setResult] = useState<UsageChangeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const executableRows = useMemo(() => rows.filter(rowIsBatchExecutable), [rows]);
  const blockedRows = useMemo(() => rows.filter((row) => !rowIsBatchExecutable(row)), [rows]);
  const checkedRows = useMemo(
    () => executableRows.filter((row) => checkedIds.has(relationIdOf(row.relation))),
    [checkedIds, executableRows],
  );
  const selection = summarizeBatchSelection(checkedRows);
  const sharedConfirmationMissing = checkedRows.some((row) => {
    const relationId = relationIdOf(row.relation);
    return rowNeedsSharedImpactConfirmation(row) && !sharedConfirmedIds.has(relationId);
  });
  const requiresFullCopy = checkedRows.some((row) => row.relation.kind === "deployment"
    && (row.relation.fact.relationship === "shared_directory_read"
      || row.relation.fact.relationship === "shared_directory_reference"));
  const effectiveForm: UsageForm = requiresFullCopy ? "full_copy" : requestedForm;
  const disabled = busy || prepared !== null;
  const title = t("relationships.governance.manage.title");

  const prepare = async () => {
    if (checkedRows.length === 0 || selection.kind !== "deployment" || sharedConfirmationMissing) return;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const request: PrepareUsageChange = {
        operation_id: newOperationId(),
        action: "manage",
        relation_ids: checkedRows.map((row) => relationIdOf(row.relation)),
        problem_id: null,
        skill_id: null,
        requested_form: effectiveForm,
        copy_disposition: null,
        content_basis: contentBasis,
        retain_entry_key: null,
        selected_entry_keys: [],
        runtime_name: null,
        base_version_id: null,
        non_recognized_destination: null,
      };
      setPrepared(await onPrepare(request));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const commit = async () => {
    if (!prepared) return;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      setResult(await onCommit({
        operation_id: prepared.operation_id,
        prepared_id: prepared.prepared_id,
      }));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const resetPreview = () => {
    setPrepared(null);
    setResult(null);
    setError(null);
  };

  return (
    <section aria-label={title} className="sh-governance__dialog" data-testid="usage-manage-dialog" role="dialog">
      <h3>{title}</h3>
      {result ? (
        <ManageResult result={result} />
      ) : (
        <>
          <p>{t("relationships.governance.manage.description")}</p>
          {allowSelection ? (
            <ul className="sh-governance__batch-items">
              {executableRows.map((row) => {
                const relationId = relationIdOf(row.relation);
                const needsSharedConfirmation = rowNeedsSharedImpactConfirmation(row);
                return (
                  <li data-testid={`usage-manage-item-${relationId}`} key={relationId}>
                    <label>
                      <input
                        aria-label={t("relationships.governance.manage.itemCheck", { name: governanceSkillDisplayName(row, t) })}
                        checked={checkedIds.has(relationId)}
                        disabled={disabled}
                        onChange={(event) => onToggleItem?.(relationId, event.target.checked)}
                        type="checkbox"
                      />
                      <span>{governanceSkillDisplayName(row, t)}</span>
                    </label>
                    <span>{displayPath(row.relation.kind === "deployment" ? row.relation.fact.path : row.relation.fact.source_path)}</span>
                    {needsSharedConfirmation ? (
                      <label className="sh-governance__confirm-check">
                        <input
                          aria-label={t("relationships.governance.batch.sharedImpactConfirm", { name: governanceSkillDisplayName(row, t) })}
                          checked={sharedConfirmedIds.has(relationId)}
                          disabled={disabled}
                          onChange={(event) => onSharedImpactConfirm?.(relationId, event.target.checked)}
                          type="checkbox"
                        />
                        {t("relationships.governance.preview.sharedImpactConfirm")}
                      </label>
                    ) : null}
                  </li>
                );
              })}
              {blockedRows.map((row) => (
                <li key={relationIdOf(row.relation)}>
                  <span>{governanceSkillDisplayName(row, t)}</span>
                  <span>{t("relationships.governance.batch.itemBlocked")}</span>
                </li>
              ))}
            </ul>
          ) : checkedRows.map((row) => (
            <div key={relationIdOf(row.relation)}>
              <p>{governanceSkillDisplayName(row, t)}</p>
              {rowNeedsSharedImpactConfirmation(row) ? (
                <label className="sh-governance__confirm-check">
                  <input
                    aria-label={t("relationships.governance.batch.sharedImpactConfirm", { name: governanceSkillDisplayName(row, t) })}
                    checked={sharedConfirmedIds.has(relationIdOf(row.relation))}
                    disabled={disabled}
                    onChange={(event) => onSharedImpactConfirm?.(relationIdOf(row.relation), event.target.checked)}
                    type="checkbox"
                  />
                  {t("relationships.governance.preview.sharedImpactConfirm")}
                </label>
              ) : null}
            </div>
          ))}
          {!prepared ? (
            <>
              <fieldset disabled={disabled}>
                <legend>{t("relationships.governance.manage.contentBasis")}</legend>
                <label>
                  <input
                    checked={contentBasis === "library_current"}
                    name="usage-manage-content-basis"
                    onChange={() => setContentBasis("library_current")}
                    type="radio"
                  />
                  {t("relationships.governance.manage.libraryCurrent")}
                </label>
                <label>
                  <input
                    checked={contentBasis === "original_entry"}
                    name="usage-manage-content-basis"
                    onChange={() => setContentBasis("original_entry")}
                    type="radio"
                  />
                  {t("relationships.governance.manage.originalEntry")}
                </label>
              </fieldset>
              <fieldset disabled={disabled}>
                <legend>{t("relationships.governance.manage.form")}</legend>
                <label>
                  <input
                    checked={effectiveForm === "link"}
                    disabled={requiresFullCopy}
                    name="usage-manage-form"
                    onChange={() => setRequestedForm("link")}
                    type="radio"
                  />
                  {t("undeploy.flow.forms.link")}
                </label>
                <label>
                  <input
                    checked={effectiveForm === "full_copy"}
                    name="usage-manage-form"
                    onChange={() => setRequestedForm("full_copy")}
                    type="radio"
                  />
                  {t("undeploy.flow.forms.full_copy")}
                </label>
              </fieldset>
              {requiresFullCopy ? <p role="note">{t("relationships.governance.manage.sharedCopyRequired")}</p> : null}
            </>
          ) : (
            <>
              <RelationshipRemovalImpactView defaultOpen usageChange={prepared} />
              <Button disabled={disabled} onClick={resetPreview} variant="secondary">
                {t("relationships.governance.manage.changeSelection")}
              </Button>
            </>
          )}
          {busy ? <p role="status">{t(prepared ? "relationships.governance.manage.committing" : "relationships.governance.manage.preparing")}</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          <div className="sh-governance__dialog-actions">
            <Button disabled={busy} onClick={onClose} variant="secondary">{t("actions.cancel")}</Button>
            {prepared ? (
              <Button disabled={busy} onClick={() => void commit()}>
                {t("relationships.governance.manage.confirm")}
              </Button>
            ) : (
              <Button
                disabled={disabled || checkedRows.length === 0 || selection.kind !== "deployment" || sharedConfirmationMissing}
                onClick={() => void prepare()}
              >
                {t("relationships.governance.manage.preview")}
              </Button>
            )}
          </div>
        </>
      )}
      {result ? (
        <div className="sh-governance__dialog-actions">
          <Button onClick={onClose} variant="secondary">{t("relationships.governance.manage.close")}</Button>
        </div>
      ) : null}
    </section>
  );
}

function ManageResult({ result }: { result: UsageChangeResult }) {
  const { t } = useTranslation();
  const applied = result.item_results.filter((item) => item.status === "applied").length;
  const failed = result.item_results.length - applied;
  const summary = result.item_results.length === 0 || failed > 0
    ? t("relationships.governance.manage.resultPartial", { applied, failed })
    : t("relationships.governance.manage.resultComplete", { applied });
  return (
    <div data-testid="usage-manage-result">
      <h4>{t("relationships.governance.manage.resultHeading")}</h4>
      <p role={failed > 0 || result.recovery_required ? "alert" : "status"}>{summary}</p>
      {result.recovery_required ? <p role="alert">{t("undeploy.flow.results.recovery_required")}</p> : null}
      <ul className="sh-governance__batch-items">
        {result.item_results.map((item, index) => (
          <li key={`${item.relation_ids.join(":")}-${index}`}>
            <strong>{targetLabel(item.target, (key) => String(t(key as never)))}</strong>
            <span>{t(`undeploy.flow.results.${item.status}` as never)}</span>
            <span>{t(`undeploy.flow.actions.${item.action}` as never)}</span>
            {item.reason ? <p>{t("relationships.governance.manage.resultReason", { reason: item.reason })}</p> : null}
            {item.recovery_point ? <p>{t("undeploy.flow.recoveryPoint", { path: displayPath(item.recovery_point.path) })}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
