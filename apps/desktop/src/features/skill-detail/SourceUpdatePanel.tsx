import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppliedSourceUpdate, UpdateDecision, UpstreamCheckResult } from "../../api/bindings";
import { Button } from "../../ui/Button";

export interface SourceUpdateFacade {
  checkSourceUpdate: (skillId: string) => Promise<UpstreamCheckResult>;
  applySourceUpdate: (skillId: string, decision: UpdateDecision) => Promise<AppliedSourceUpdate>;
}

interface SourceUpdatePanelProps {
  facade: SourceUpdateFacade;
  skillId: string;
}

type PanelState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "result"; result: UpstreamCheckResult }
  | { phase: "applied"; applied: AppliedSourceUpdate }
  | { phase: "error"; message: string };

/**
 * FE-11 来源更新：检查上游版本并按显式决策应用（采用/保留本地/独立分支）。
 * 只在用户点击后联网；每个状态都如实呈现，不把"无法检查"伪装成"已最新"。
 */
export function SourceUpdatePanel({ facade, skillId }: SourceUpdatePanelProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<PanelState>({ phase: "idle" });

  const check = async () => {
    setState({ phase: "checking" });
    try {
      const result = await facade.checkSourceUpdate(skillId);
      setState({ phase: "result", result });
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const decide = async (decision: UpdateDecision) => {
    if (decision === "cancel") {
      setState({ phase: "idle" });
      return;
    }
    setState({ phase: "checking" });
    try {
      const applied = await facade.applySourceUpdate(skillId, decision);
      setState({ phase: "applied", applied });
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <section aria-label={t("skillDetail.sourceUpdate.ariaLabel")} className="sh-source-update">
      {state.phase === "idle" || state.phase === "checking" ? (
        <Button disabled={state.phase === "checking"} onClick={() => void check()} variant="secondary">
          {state.phase === "checking" ? t("skillDetail.sourceUpdate.checking") : t("skillDetail.sourceUpdate.check")}
        </Button>
      ) : (
        <Button onClick={() => void check()} variant="secondary">
          {t("skillDetail.sourceUpdate.recheck")}
        </Button>
      )}

      {state.phase === "error" ? <p role="alert">{t("skillDetail.sourceUpdate.failed", { error: state.message })}</p> : null}

      {state.phase === "result" ? <ResultView decide={decide} result={state.result} /> : null}

      {state.phase === "applied" ? <AppliedResult applied={state.applied} /> : null}
    </section>
  );
}

function AppliedResult({ applied }: { applied: AppliedSourceUpdate }) {
  const { t } = useTranslation();
  let summary: string;
  if (applied.decision === "take_upstream" && applied.new_version) {
    summary = t("skillDetail.sourceUpdate.appliedUpstream", { version: applied.new_version });
  } else if (applied.decision === "keep_local") {
    summary = t("skillDetail.sourceUpdate.keptLocal");
  } else if (applied.decision === "create_independent_branch" && applied.new_version) {
    summary = t("skillDetail.sourceUpdate.appliedBranch", { version: applied.new_version });
  } else {
    summary = t("skillDetail.sourceUpdate.appliedGeneric");
  }
  return (
    <div>
      <p role="status">{summary}</p>
      {applied.deployments_need_reconciliation ? (
        <p role="status">{t("skillDetail.sourceUpdate.reconcile")}</p>
      ) : null}
    </div>
  );
}

function ResultView({
  result,
  decide,
}: {
  result: UpstreamCheckResult;
  decide: (decision: UpdateDecision) => Promise<void>;
}) {
  const { t } = useTranslation();

  if (result.state === "up_to_date") {
    return <p role="status">{t("skillDetail.sourceUpdate.upToDate")}</p>;
  }
  if (result.state === "source_unavailable") {
    return <p role="status">{t("skillDetail.sourceUpdate.unavailable")}</p>;
  }
  if (result.state === "authentication_required") {
    return <p role="status">{t("skillDetail.sourceUpdate.authRequired")}</p>;
  }

  const withLocalChanges = result.state === "update_available_with_local_changes";
  return (
    <div>
      <p role="status">
        {withLocalChanges
          ? t("skillDetail.sourceUpdate.availableWithChanges", {
              local: result.local_version ?? "—",
              upstream: result.upstream_version ?? "—",
            })
          : t("skillDetail.sourceUpdate.available", {
              local: result.local_version ?? "—",
              upstream: result.upstream_version ?? "—",
            })}
      </p>
      <div className="sh-source-update__actions">
        <Button onClick={() => void decide("take_upstream")} variant="primary">
          {t("skillDetail.sourceUpdate.takeUpstream")}
        </Button>
        <Button onClick={() => void decide("keep_local")} variant="secondary">
          {t("skillDetail.sourceUpdate.keepLocal")}
        </Button>
        <Button onClick={() => void decide("create_independent_branch")} variant="secondary">
          {t("skillDetail.sourceUpdate.independent")}
        </Button>
        <Button onClick={() => void decide("cancel")} variant="ghost">
          {t("actions.cancel")}
        </Button>
      </div>
    </div>
  );
}
