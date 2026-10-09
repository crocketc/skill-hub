import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { displayPath } from "../../platform/displayPath";
import type {
  CommitUsageChange,
  PreparedUsageChange,
  PrepareUsageChange,
  UsageChangeResult,
  UsageEntryKey,
  UsageRelationTarget,
  UsageRelationView,
} from "../../api/bindings";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { AgentPresentation } from "../../ui/AgentPresentation";
import { RelationshipRemovalImpactView } from "../relationshipGovernance/RelationshipRemovalImpactView";
import { RemovalShell } from "./RemovalShell";

export type UsageReleaseScope =
  | { kind: "skill"; skillId: string }
  | { kind: "relation"; relationId: string };

export interface UndeployDialogProps {
  candidates: UsageRelationView[];
  error?: string;
  onCancel: () => void;
  onCommit: (request: CommitUsageChange) => Promise<UsageChangeResult>;
  onPrepare: (request: PrepareUsageChange) => Promise<PreparedUsageChange>;
  scope: UsageReleaseScope;
}

type CopyDisposition = NonNullable<PrepareUsageChange["copy_disposition"]>;

const TARGET_KINDS = ["agent", "shared_directory", "project"] as const;

function entryKeyIdentity(entryKey: UsageEntryKey | null): string | null {
  return entryKey ? JSON.stringify([entryKey.directory_id, entryKey.relative_entry_path]) : null;
}

function releaseOperationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `release-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function targetLabel(target: UsageRelationTarget, t: (key: string) => string) {
  switch (target.kind) {
    case "agent": return t("undeploy.flow.groups.agent");
    case "shared_directory": return t("undeploy.flow.groups.shared");
    case "project": return t("undeploy.flow.groups.project");
  }
}

function actionLabel(action: PreparedUsageChange["impacts"][number]["action"], t: (key: string) => string) {
  return t(`undeploy.flow.actions.${action}`);
}

function resultLabel(status: UsageChangeResult["item_results"][number]["status"], t: (key: string) => string) {
  return t(`undeploy.flow.results.${status}`);
}

export function UndeployDialog({
  candidates,
  error: externalError,
  onCancel,
  onCommit,
  onPrepare,
  scope,
}: UndeployDialogProps) {
  const { t } = useTranslation();
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set(
    scope.kind === "relation"
      ? candidates.map((candidate) => entryKeyIdentity(candidate.entry_key)).filter((key): key is string => key !== null)
      : [],
  ));
  const [copyDisposition, setCopyDisposition] = useState<CopyDisposition | null>(null);
  const [prepared, setPrepared] = useState<PreparedUsageChange | null>(null);
  const [result, setResult] = useState<UsageChangeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(externalError ?? null);

  useEffect(() => setError(externalError ?? null), [externalError]);

  const selectableCandidates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      const identity = entryKeyIdentity(candidate.entry_key);
      if (identity) counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    return candidates.filter((candidate) => {
      const identity = entryKeyIdentity(candidate.entry_key);
      return candidate.active
        && candidate.entry_key !== null
        && candidate.form !== null
        && candidate.physical_source_ids_evidence.length <= 1
        && identity !== null
        && counts.get(identity) === 1
        && candidate.target.directory_role !== "builtin";
    });
  }, [candidates]);
  const selectedCandidates = useMemo(() => selectableCandidates.filter((candidate) => {
    if (scope.kind === "relation") {
      return candidate.relation_id === scope.relationId
        || candidate.evidence_relation_ids.includes(scope.relationId);
    }
    const identity = entryKeyIdentity(candidate.entry_key);
    return identity !== null && selectedKeys.has(identity);
  }), [scope, selectableCandidates, selectedKeys]);
  const hasCopy = selectedCandidates.some((candidate) => candidate.form === "full_copy" && candidate.management === "managed");
  const groupedCandidates = useMemo(() => Object.fromEntries(TARGET_KINDS.map((kind) => [
    kind,
    selectableCandidates.filter((candidate) => candidate.target.kind === kind),
  ])), [selectableCandidates]);

  const toggleCandidate = (candidate: UsageRelationView, checked: boolean) => {
    const identity = entryKeyIdentity(candidate.entry_key);
    if (!identity || scope.kind === "relation") return;
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(identity);
      else next.delete(identity);
      return next;
    });
  };

  const prepare = async () => {
    if (selectedCandidates.length === 0 || (hasCopy && copyDisposition === null)) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const request: PrepareUsageChange = {
        operation_id: releaseOperationId(),
        action: "release",
        relation_ids: scope.kind === "relation" ? [scope.relationId] : [],
        problem_id: null,
        skill_id: scope.kind === "skill" ? scope.skillId : null,
        requested_form: null,
        copy_disposition: hasCopy ? copyDisposition : null,
        content_basis: null,
        retain_entry_key: null,
        selected_entry_keys: scope.kind === "skill"
          ? [...new Map(selectedCandidates.flatMap((candidate) => candidate.entry_key ? [[
              entryKeyIdentity(candidate.entry_key)!, candidate.entry_key,
            ] as const] : [])).values()]
          : [],
        runtime_name: null,
        base_version_id: null,
        non_recognized_destination: null,
      };
      setPrepared(await onPrepare(request));
    } catch (reason) {
      setError(describeNativeError(
        reason,
        (key, options) => String(t(key as never, options as never)),
        "tasks.notices.failureUnknown",
      ));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!prepared) return;
    setBusy(true);
    setError(null);
    try {
      const nextResult = await onCommit({
        operation_id: prepared.operation_id,
        prepared_id: prepared.prepared_id,
      });
      setResult(nextResult);
    } catch (reason) {
      setError(describeNativeError(
        reason,
        (key, options) => String(t(key as never, options as never)),
        "tasks.notices.failureUnknown",
      ));
    } finally {
      setBusy(false);
    }
  };

  const title = scope.kind === "skill"
    ? t("undeploy.flow.heading", { target: selectedCandidates.length })
    : t("undeploy.flow.relationHeading");
  const committedSummary = result
    ? t(result.item_results.length === 0 || result.item_results.some((item) => item.status !== "applied")
      ? "undeploy.flow.results.partial"
      : "undeploy.flow.results.complete", {
        applied: result.item_results.filter((item) => item.status === "applied").length,
        failed: result.item_results.filter((item) => item.status !== "applied").length,
      })
    : null;

  return (
    <RemovalShell
      eyebrow={t("undeploy.flow.eyebrow")}
      footer={result ? (
        <div className="sh-removal-flow__actions-group sh-removal-flow__actions-group--primary">
          <Button onClick={onCancel} size="lg" variant="secondary">{t("undeploy.flow.close")}</Button>
        </div>
      ) : (
        <>
          <div className="sh-removal-flow__actions-group">
            <Button disabled={busy} onClick={onCancel} variant="secondary">{t("actions.cancel")}</Button>
          </div>
          <div className="sh-removal-flow__actions-group sh-removal-flow__actions-group--primary">
            {prepared ? (
              <Button disabled={busy} onClick={() => void commit()} size="lg" variant="danger">
                {busy ? t("undeploy.flow.submitting") : t("undeploy.flow.confirm")}
              </Button>
            ) : (
              <Button
                disabled={busy || selectedCandidates.length === 0 || (hasCopy && copyDisposition === null)}
                onClick={() => void prepare()}
                size="lg"
                variant="danger"
              >
                {busy ? t("undeploy.flow.preparing") : t("undeploy.flow.preview")}
              </Button>
            )}
          </div>
        </>
      )}
      status={busy ? { kind: "info", text: prepared ? t("undeploy.flow.submitting") : t("undeploy.flow.preparing") } : null}
      title={title}
    >
      {!prepared && !result ? (
        <>
          <p>{t("undeploy.flow.description")}</p>
          {scope.kind === "skill" ? TARGET_KINDS.map((kind) => (
            <fieldset className="sh-removal-flow__selection-group" key={kind}>
              <legend>{targetLabel({ kind, directory_id: null, agent_client_id: null, directory_role: null, recognition: null }, (key) => String(t(key as never)))}</legend>
              {groupedCandidates[kind].length === 0 ? (
                <p>{t("undeploy.flow.noTargets")}</p>
              ) : groupedCandidates[kind].map((candidate) => {
                const identity = entryKeyIdentity(candidate.entry_key);
                if (!identity) return null;
                const agentLabel = candidate.target.agent_client_id
                  ? <AgentPresentation agentId={candidate.target.agent_client_id} />
                  : null;
                const label = [
                  targetLabel(candidate.target, (key) => String(t(key as never))),
                  agentLabel,
                  candidate.entry_key?.relative_entry_path,
                ].filter(Boolean);
                return (
                  <label className="sh-removal-flow__selection-item" key={identity}>
                    <input
                      checked={selectedKeys.has(identity)}
                      onChange={(event) => toggleCandidate(candidate, event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>{label.length > 0 ? label.map((part, index) => <span key={index}>{index > 0 ? " · " : ""}{part}</span>) : targetLabel(candidate.target, (key) => String(t(key as never)))}</span>
                    <span>{t(`undeploy.flow.forms.${candidate.form ?? "unknown"}`)}</span>
                  </label>
                );
              })}
            </fieldset>
          )) : (
            <p>{t("undeploy.flow.relationDescription", {
              target: selectedCandidates[0]?.target
                ? targetLabel(selectedCandidates[0].target, (key) => String(t(key as never)))
                : t("undeploy.flow.unknownTarget"),
            })}</p>
          )}
          {hasCopy ? (
            <fieldset aria-label={t("undeploy.flow.copyHandling")} className="sh-removal-flow__selection-group">
              <legend>{t("undeploy.flow.copyHandling")}</legend>
              <label>
                <input checked={copyDisposition === "keep_independent"} name="usage-copy-disposition" onChange={() => setCopyDisposition("keep_independent")} type="radio" />
                {t("undeploy.flow.copyChoices.keep")}
              </label>
              <label>
                <input checked={copyDisposition === "remove_with_backup"} name="usage-copy-disposition" onChange={() => setCopyDisposition("remove_with_backup")} type="radio" />
                {t("undeploy.flow.copyChoices.remove")}
              </label>
            </fieldset>
          ) : null}
        </>
      ) : null}

      {prepared ? (
        <RelationshipRemovalImpactView
          defaultOpen
          usageChange={prepared}
        />
      ) : null}

      {result ? (
        <section aria-label={t("undeploy.flow.resultHeading")} data-testid="usage-release-result">
          <h3>{t("undeploy.flow.resultHeading")}</h3>
          <p role="status">{committedSummary}</p>
          <ul>
            {result.item_results.map((item, index) => (
              <li key={`${item.relation_ids.join(":")}-${index}`}>
                <strong>{resultLabel(item.status, (key) => String(t(key as never)))}</strong>
                <span> · {targetLabel(item.target, (key) => String(t(key as never)))}</span>
                <span> · {actionLabel(item.action, (key) => String(t(key as never)))}</span>
                {item.reason ? <p>{describeNativeError(
                  { code: item.reason, params: {}, severity: "error", actions: [] },
                  (key, options) => String(t(key as never, options as never)),
                  "tasks.notices.failureUnknown",
                )}</p> : null}
                {item.recovery_point ? <p>{t("undeploy.flow.recoveryPoint", { path: displayPath(item.recovery_point.path) })}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </RemovalShell>
  );
}
