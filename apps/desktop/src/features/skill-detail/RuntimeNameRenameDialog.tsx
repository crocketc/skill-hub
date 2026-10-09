import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type {
  CommitUsageChange,
  PreparedUsageChange,
  PrepareUsageChange,
  UsageChangeResult,
} from "../../api/bindings";
import { describeNativeError } from "../../api/nativeErrors";
import { displayPath } from "../../platform/displayPath";
import { Button } from "../../ui/Button";
import { RemovalShell } from "../removal/RemovalShell";

export interface RuntimeNameRenameDialogProps {
  onCancel: () => void;
  onCommit: (request: CommitUsageChange) => Promise<UsageChangeResult>;
  onPrepare: (request: PrepareUsageChange) => Promise<PreparedUsageChange>;
  skillId: string;
}

function renameOperationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `runtime-rename-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function RuntimeNameRenameDialog({ onCancel, onCommit, onPrepare, skillId }: RuntimeNameRenameDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [prepared, setPrepared] = useState<PreparedUsageChange | null>(null);
  const [result, setResult] = useState<UsageChangeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const renamePreview = prepared?.subject_rename ?? null;
  const appliedCount = result?.item_results.filter((item) => item.status === "applied").length ?? 0;
  const failedCount = result?.item_results.filter((item) => item.status !== "applied").length ?? 0;

  const prepare = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const nextPrepared = await onPrepare({
        operation_id: renameOperationId(),
        action: "rename_subject",
        relation_ids: [],
        problem_id: null,
        skill_id: skillId,
        requested_form: null,
        copy_disposition: null,
        content_basis: null,
        retain_entry_key: null,
        selected_entry_keys: [],
        runtime_name: draft.trim(),
        base_version_id: null,
        non_recognized_destination: null,
      });
      if (!nextPrepared.subject_rename) {
        throw new Error(String(t("skillDetail.runtimeRename.previewMissing")));
      }
      setPrepared(nextPrepared);
    } catch (reason) {
      setPrepared(null);
      setError(describeNativeError(
        reason,
        (key, options) => String(t(key as never, options as never)),
        "skillDetail.runtimeRename.failed",
      ));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!prepared?.subject_rename || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await onCommit({ operation_id: prepared.operation_id, prepared_id: prepared.prepared_id }));
    } catch (reason) {
      setPrepared(null);
      setError(describeNativeError(
        reason,
        (key, options) => String(t(key as never, options as never)),
        "skillDetail.runtimeRename.failed",
      ));
    } finally {
      setBusy(false);
    }
  };

  const status = result
    ? result.recovery_required
      ? { kind: "warning" as const, text: t("skillDetail.runtimeRename.recovery") }
      : failedCount > 0
        ? { kind: "warning" as const, text: t("skillDetail.runtimeRename.partial", { applied: appliedCount, failed: failedCount }) }
        : { kind: "success" as const, text: t("skillDetail.runtimeRename.completed", { count: appliedCount }) }
    : busy
      ? { kind: "info" as const, text: prepared ? t("skillDetail.runtimeRename.submitting") : t("skillDetail.runtimeRename.previewing") }
      : null;

  return (
    <RemovalShell
      eyebrow={t("skillDetail.runtimeRename.eyebrow")}
      footer={result ? (
        <div className="sh-removal-flow__actions-group sh-removal-flow__actions-group--primary">
          <Button onClick={onCancel} size="lg" variant="secondary">{t("skillDetail.runtimeRename.close")}</Button>
        </div>
      ) : (
        <>
          <div className="sh-removal-flow__actions-group">
            <Button disabled={busy} onClick={onCancel} variant="secondary">{t("actions.cancel")}</Button>
            {prepared ? (
              <Button disabled={busy} onClick={() => { setPrepared(null); setError(undefined); }} variant="ghost">{t("skillDetail.runtimeRename.edit")}</Button>
            ) : null}
          </div>
          <div className="sh-removal-flow__actions-group sh-removal-flow__actions-group--primary">
            {prepared ? (
              <Button disabled={busy} onClick={() => void commit()} size="lg">
                {busy ? t("skillDetail.runtimeRename.submitting") : t("skillDetail.runtimeRename.confirm")}
              </Button>
            ) : (
              <Button disabled={busy || !draft.trim()} onClick={() => void prepare()} size="lg">
                {busy ? t("skillDetail.runtimeRename.previewing") : t("skillDetail.runtimeRename.preview")}
              </Button>
            )}
          </div>
        </>
      )}
      status={status}
      title={t("skillDetail.runtimeRename.title")}
    >
      {!prepared ? (
        <>
          <p>{t("skillDetail.runtimeRename.description")}</p>
          <label className="sh-runtime-name-rename__field">
            {t("skillDetail.runtimeRename.input")}
            <input
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setDraft(event.currentTarget.value)}
              type="text"
              value={draft}
            />
          </label>
        </>
      ) : renamePreview ? (
        <section aria-label={t("skillDetail.runtimeRename.previewTitle")} className="sh-runtime-name-rename__preview">
          <p>{t("skillDetail.runtimeRename.change", { previous: renamePreview.previous_runtime_name, next: renamePreview.runtime_name })}</p>
          <h3>{t("skillDetail.runtimeRename.targetsHeading", { count: renamePreview.targets.length })}</h3>
          {renamePreview.targets.length === 0 ? (
            <p>{t("skillDetail.runtimeRename.noTargets")}</p>
          ) : (
            <ul className="sh-runtime-name-rename__targets">
              {renamePreview.targets.map((target) => {
                const previousPath = displayPath(target.previous_path);
                const nextPath = displayPath(target.path);
                return (
                  <li key={`${target.target_id}:${target.deployment_id}`}>
                    <span>{t(`skillDetail.runtimeRename.modes.${target.mode}`)}</span>
                    <code title={`${target.previous_path} → ${target.path}`}>{previousPath} → {nextPath}</code>
                  </li>
                );
              })}
            </ul>
          )}
          {result?.recovery_required ? <p><Link to="/recovery">{t("skillDetail.runtimeRename.openRecovery")}</Link></p> : null}
        </section>
      ) : null}
      {error ? <p className="sh-removal-flow__error" role="alert">{error}</p> : null}
    </RemovalShell>
  );
}
