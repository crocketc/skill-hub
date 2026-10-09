import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CommitUsageChange,
  PrepareUsageChange,
  PreparedUsageChange,
  RelationGovernanceRow,
  UsageChangeResult,
} from "../../../api/bindings";
import { describeNativeError } from "../../../api/nativeErrors";
import { displayPath } from "../../../platform/displayPath";
import { Button } from "../../../ui/Button";
import { RelationshipRemovalImpactView } from "../../relationshipGovernance/RelationshipRemovalImpactView";
import { relationIdOf } from "./api";
import { governanceSkillDisplayName } from "./GovernanceRelationTable";

export type ManagedUsageChangeAction = "sync" | "repair" | "restore";

export interface ManagedUsageChangeDialogProps {
  action: ManagedUsageChangeAction;
  row: RelationGovernanceRow;
  onPrepare: (request: PrepareUsageChange) => Promise<PreparedUsageChange>;
  onCommit: (request: CommitUsageChange) => Promise<UsageChangeResult>;
  onClose: () => void;
}

function newOperationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `managed-usage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function targetLabel(target: UsageChangeResult["item_results"][number]["target"], t: (key: string) => string) {
  switch (target.kind) {
    case "agent": return t("undeploy.flow.groups.agent");
    case "shared_directory": return t("undeploy.flow.groups.shared");
    case "project": return t("undeploy.flow.groups.project");
  }
}

/** Managed copy/link changes use the same frozen prepare snapshot as release and conversion. */
export function ManagedUsageChangeDialog({
  action,
  onClose,
  onCommit,
  onPrepare,
  row,
}: ManagedUsageChangeDialogProps) {
  const { t } = useTranslation();
  const key = `relationships.governance.managedChange.${action}` as const;
  const title = String(t(`${key}.title` as never));
  const relationId = relationIdOf(row.relation);
  const targetPath = row.relation.kind === "deployment"
    ? row.relation.fact.path
    : row.relation.fact.source_path;
  const [contentConfirmed, setContentConfirmed] = useState(false);
  const [prepared, setPrepared] = useState<PreparedUsageChange | null>(null);
  const [result, setResult] = useState<UsageChangeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requiresContentChoice = action !== "restore";
  const describeError = (reason: unknown) => describeNativeError(
    reason,
    (errorKey, options) => String(t(errorKey as never, options as never)),
    "tasks.notices.failureUnknown",
  );

  const prepare = async () => {
    if (requiresContentChoice && !contentConfirmed) return;
    setBusy(true);
    setError(null);
    try {
      const request: PrepareUsageChange = {
        operation_id: newOperationId(),
        action,
        relation_ids: [relationId],
        problem_id: null,
        skill_id: null,
        requested_form: null,
        copy_disposition: null,
        content_basis: requiresContentChoice ? "library_current" : null,
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
    }
  };

  const commit = async () => {
    if (!prepared) return;
    setBusy(true);
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
    }
  };

  const retry = () => {
    setContentConfirmed(false);
    setPrepared(null);
    setResult(null);
    setError(null);
  };

  return (
    <section aria-label={title} className="sh-governance__dialog" data-testid="managed-usage-change-dialog" role="dialog">
      <h3>{title}</h3>
      {result ? (
        <ManagedUsageChangeResult result={result} />
      ) : (
        <>
          <p>{t(`${key}.description` as never)}</p>
          <dl className="sh-governance__facts">
            <div>
              <dt>{t("undeploy.flow.entriesHeading")}</dt>
              <dd>{displayPath(targetPath)}</dd>
            </div>
            <div>
              <dt>{t("relationships.governance.table.relation")}</dt>
              <dd>{governanceSkillDisplayName(row, t)}</dd>
            </div>
          </dl>
          {requiresContentChoice && !prepared ? (
            <label className="sh-governance__confirm-check">
              <input
                checked={contentConfirmed}
                disabled={busy}
                onChange={(event) => setContentConfirmed(event.target.checked)}
                type="checkbox"
              />
              {t(`${key}.contentChoice` as never)}
            </label>
          ) : null}
          {prepared ? (
            <>
              <RelationshipRemovalImpactView defaultOpen usageChange={prepared} />
              <Button disabled={busy} onClick={retry} variant="secondary">
                {t("relationships.governance.managedChange.changePreview" as never)}
              </Button>
            </>
          ) : null}
          {busy ? <p role="status">{t(`${key}.${prepared ? "committing" : "preparing"}` as never)}</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          <div className="sh-governance__dialog-actions">
            <Button disabled={busy} onClick={onClose} variant="secondary">{t("actions.cancel")}</Button>
            {prepared ? (
              <Button disabled={busy} onClick={() => void commit()}>
                {t(`${key}.confirm` as never)}
              </Button>
            ) : (
              <Button
                disabled={busy || (requiresContentChoice && !contentConfirmed)}
                onClick={() => void prepare()}
              >
                {t("relationships.governance.managedChange.preview" as never)}
              </Button>
            )}
          </div>
        </>
      )}
      {result ? (
        <div className="sh-governance__dialog-actions">
          {result.item_results.some((item) => item.status !== "applied") || result.recovery_required ? (
            <Button disabled={busy} onClick={retry} variant="secondary">
              {t("relationships.governance.managedChange.retry" as never)}
            </Button>
          ) : null}
          <Button onClick={onClose} variant="secondary">{t("relationships.governance.managedChange.close" as never)}</Button>
        </div>
      ) : null}
    </section>
  );
}

function ManagedUsageChangeResult({ result }: { result: UsageChangeResult }) {
  const { t } = useTranslation();
  const applied = result.item_results.filter((item) => item.status === "applied").length;
  const failed = result.item_results.length - applied;
  const incomplete = failed > 0 || result.recovery_required || result.item_results.length === 0;

  return (
    <div data-testid="managed-usage-change-result">
      <h4>{t("relationships.governance.managedChange.resultHeading")}</h4>
      <p role={incomplete ? "alert" : "status"}>
        {incomplete
          ? t("relationships.governance.managedChange.resultPartial", { applied, failed })
          : t("relationships.governance.managedChange.resultComplete", { applied })}
      </p>
      {result.recovery_required ? <p role="alert">{t("undeploy.flow.results.recovery_required")}</p> : null}
      <ul className="sh-governance__batch-items">
        {result.item_results.map((item, index) => (
          <li key={`${item.relation_ids.join(":")}-${index}`}>
            <strong>{targetLabel(item.target, (key) => String(t(key as never)))}</strong>
            <span>{t(`undeploy.flow.results.${item.status}` as never)}</span>
            <span>{t(`undeploy.flow.actions.${item.action}` as never)}</span>
            {item.reason ? <p>{t("relationships.governance.managedChange.resultReason", { reason: item.reason })}</p> : null}
            {item.recovery_point ? <p>{t("undeploy.flow.recoveryPoint", { path: displayPath(item.recovery_point.path) })}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
