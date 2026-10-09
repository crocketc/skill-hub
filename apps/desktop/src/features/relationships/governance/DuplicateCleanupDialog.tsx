import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CommitUsageChange,
  EnvironmentProblemView,
  PrepareUsageChange,
  PreparedUsageChange,
  UsageChangeResult,
  UsageEntryKey,
} from "../../../api/bindings";
import { describeNativeError } from "../../../api/nativeErrors";
import { Button } from "../../../ui/Button";
import { Input } from "../../../ui/Input";

export interface DuplicateCleanupDialogProps {
  problem: EnvironmentProblemView;
  onPrepare: (request: PrepareUsageChange) => Promise<PreparedUsageChange>;
  onCommit: (request: CommitUsageChange) => Promise<UsageChangeResult>;
  onClose: () => void;
  onCompleted: () => void;
}

function newOperationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `duplicate-cleanup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function entryKey(entry: UsageEntryKey): string {
  return JSON.stringify([entry.directory_id, entry.relative_entry_path]);
}

function fullEntryPath(directoryPath: string | null | undefined, relativePath: string): string {
  if (!directoryPath) return relativePath;
  const separator = directoryPath.includes("\\") ? "\\" : "/";
  const root = directoryPath.replace(/[\\/]+$/, "");
  return `${root}${separator}${relativePath.replace(/[\\/]+/g, separator)}`;
}

function roleLabel(role: string | null | undefined, translate: (key: string) => string): string {
  if (role === "builtin") return translate("agents.directoryRole.builtin");
  if (role === "agent_user" || role === "agent_native") return translate("agents.directoryRole.user");
  if (role === "agent_workspace" || role === "project") return translate("agents.directoryRole.workspace");
  if (role === "shared_directory") return translate("relationships.governance.duplicateCleanup.sharedDirectory");
  return translate("relationships.governance.duplicateCleanup.unknownDirectory");
}

export function DuplicateCleanupDialog({
  problem,
  onPrepare,
  onCommit,
  onClose,
  onCompleted,
}: DuplicateCleanupDialogProps) {
  const { t } = useTranslation();
  const translate = (key: string) => String(t(key as never));
  const builtinEntries = useMemo(
    () => problem.entries.filter((entry) => entry.directory_role === "builtin"),
    [problem.entries],
  );
  const selectedBuiltin = builtinEntries.length === 1 ? builtinEntries[0] : undefined;
  const [retainKey, setRetainKey] = useState(
    selectedBuiltin
      ? entryKey(selectedBuiltin)
      : problem.entries[0]
        ? entryKey(problem.entries[0])
        : "",
  );
  const [destinationEnabled, setDestinationEnabled] = useState(false);
  const [destination, setDestination] = useState("");
  const [prepared, setPrepared] = useState<PreparedUsageChange | null>(null);
  const [result, setResult] = useState<UsageChangeResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidBuiltinSet = builtinEntries.length > 1;
  const retainEntry = problem.entries.find((entry) => entryKey(entry) === retainKey);
  const pathFor = (entry: EnvironmentProblemView["entries"][number]) => fullEntryPath(
    entry.directory_path,
    entry.relative_entry_path,
  );
  const describeError = (reason: unknown) => describeNativeError(
    reason,
    (key, options) => String(t(key as never, options as never)),
    "tasks.notices.failureUnknown",
  );

  const preview = async () => {
    if (!retainEntry || invalidBuiltinSet || (destinationEnabled && !destination.trim())) return;
    setBusy(true);
    setError(null);
    setConfirmed(false);
    try {
      const request: PrepareUsageChange = {
        operation_id: newOperationId(),
        action: "resolve_duplicate",
        relation_ids: [],
        problem_id: problem.problem_id,
        skill_id: null,
        requested_form: null,
        copy_disposition: null,
        content_basis: null,
        retain_entry_key: {
          directory_id: retainEntry.directory_id,
          relative_entry_path: retainEntry.relative_entry_path,
        },
        selected_entry_keys: problem.entries.map(({ directory_id, relative_entry_path }) => ({
          directory_id,
          relative_entry_path,
        })),
        runtime_name: null,
        base_version_id: null,
        non_recognized_destination: destinationEnabled ? destination.trim() : null,
      };
      const next = await onPrepare(request);
      if (!next.duplicate_cleanup) throw new Error(translate("relationships.governance.duplicateCleanup.previewUnavailable"));
      setPrepared(next);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!prepared || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const next = await onCommit({
        operation_id: prepared.operation_id,
        prepared_id: prepared.prepared_id,
      });
      setResult(next);
      onCompleted();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={t("relationships.governance.duplicateCleanup.title")}
      className="sh-governance__dialog sh-governance__duplicate-cleanup"
      data-testid="governance-duplicate-cleanup-dialog"
      role="dialog"
    >
      <h3>{t("relationships.governance.duplicateCleanup.title")}</h3>
      {result ? (
        <>
          <p role="status">{t(result.recovery_required
            ? "relationships.governance.duplicateCleanup.recoveryRequired"
            : "relationships.governance.duplicateCleanup.completed")}</p>
          <div className="sh-governance__dialog-actions">
            <Button onClick={onClose} size="sm" variant="secondary">{t("relationships.governance.duplicateCleanup.close")}</Button>
          </div>
        </>
      ) : (
        <>
          <p>{t("relationships.governance.duplicateCleanup.description", { count: problem.consumers.length })}</p>
          <ul className="sh-governance__duplicate-entries">
            {problem.entries.map((entry, index) => (
              <li key={`${entry.directory_id}:${entry.relative_entry_path}:${index}`}>
                <span className="sh-governance__duplicate-entry-role">{roleLabel(entry.directory_role, translate)}</span>
                <code className="sh-governance__duplicate-entry-path" title={pathFor(entry)}>{pathFor(entry)}</code>
              </li>
            ))}
          </ul>
          {invalidBuiltinSet ? (
            <p role="alert">{t("relationships.governance.duplicateCleanup.multipleBuiltins")}</p>
          ) : selectedBuiltin ? (
            <p className="sh-governance__duplicate-retain">
              {t("relationships.governance.duplicateCleanup.builtinRetained", { path: pathFor(selectedBuiltin) })}
            </p>
          ) : (
            <label className="sh-governance__duplicate-field">
              <span>{t("relationships.governance.duplicateCleanup.retainLabel")}</span>
              <select
                aria-label={t("relationships.governance.duplicateCleanup.retainLabel")}
                disabled={busy || prepared !== null}
                onChange={(event) => setRetainKey(event.target.value)}
                value={retainKey}
              >
                {problem.entries.map((entry, index) => (
                  <option key={`${entry.directory_id}:${entry.relative_entry_path}:${index}`} value={entryKey(entry)}>
                    {`${pathFor(entry)} · ${roleLabel(entry.directory_role, translate)}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!selectedBuiltin ? (
            <label className="sh-governance__confirm-check">
              <input
                checked={destinationEnabled}
                disabled={busy || prepared !== null || invalidBuiltinSet}
                onChange={(event) => setDestinationEnabled(event.target.checked)}
                type="checkbox"
              />
              {t("relationships.governance.duplicateCleanup.moveRetained")}
            </label>
          ) : null}
          {destinationEnabled && !selectedBuiltin ? (
            <label className="sh-governance__duplicate-field">
              <span>{t("relationships.governance.duplicateCleanup.destinationLabel")}</span>
              <Input
                aria-label={t("relationships.governance.duplicateCleanup.destinationLabel")}
                disabled={busy || prepared !== null}
                onChange={(event) => setDestination(event.target.value)}
                placeholder={t("relationships.governance.duplicateCleanup.destinationPlaceholder")}
                value={destination}
              />
            </label>
          ) : null}
          {prepared?.duplicate_cleanup ? (
            <div className="sh-governance__duplicate-preview" data-testid="governance-duplicate-cleanup-preview">
              <p>{t("relationships.governance.duplicateCleanup.preview", {
                count: prepared.duplicate_cleanup.selected_entry_keys.length
                  - 1
                  + (prepared.duplicate_cleanup.non_recognized_destination ? 1 : 0),
              })}</p>
              <ul>
                {prepared.duplicate_cleanup.problem.entries
                  .filter((entry) => entry.directory_id !== prepared.duplicate_cleanup?.retain_entry_key.directory_id
                    || entry.relative_entry_path !== prepared.duplicate_cleanup?.retain_entry_key.relative_entry_path
                    || prepared.duplicate_cleanup.non_recognized_destination)
                  .map((entry, index) => (
                    <li key={`${entry.directory_id}:${entry.relative_entry_path}:${index}`}>
                      <code className="sh-governance__duplicate-entry-path">{pathFor(entry)}</code>
                    </li>
                  ))}
              </ul>
              <p>{t("relationships.governance.duplicateCleanup.backupBeforeRemove")}</p>
              {prepared.duplicate_cleanup.non_recognized_destination ? (
                <p className="sh-governance__duplicate-destination">
                  {t("relationships.governance.duplicateCleanup.destinationPreview", {
                    path: prepared.duplicate_cleanup.non_recognized_destination,
                  })}
                </p>
              ) : null}
              <label className="sh-governance__confirm-check">
                <input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
                {t("relationships.governance.duplicateCleanup.confirmLabel")}
              </label>
            </div>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <div className="sh-governance__dialog-actions">
            <Button disabled={busy} onClick={onClose} size="sm" variant="secondary">{t("relationships.governance.duplicateCleanup.cancel")}</Button>
            {prepared ? (
              <Button disabled={busy || !confirmed} onClick={() => void commit()} size="sm">
                {t("relationships.governance.duplicateCleanup.confirm")}
              </Button>
            ) : (
              <Button disabled={busy || !retainEntry || invalidBuiltinSet || (destinationEnabled && !destination.trim())} onClick={() => void preview()} size="sm">
                {t("relationships.governance.duplicateCleanup.previewAction")}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
