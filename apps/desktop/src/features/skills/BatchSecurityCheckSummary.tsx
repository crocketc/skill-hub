import { useTranslation } from "react-i18next";
import type { SecurityCheckKind } from "../security/api";
import type { LlmCapabilityBlockReason, LlmCapabilityState } from "../settings/llmStatus";

const CAPABILITY_REASON_KEYS: Record<LlmCapabilityBlockReason, string> = {
  preconditions_missing: "settings.llm.status.preconditionsMissing",
  provider_unselected: "settings.llm.status.providerUnselected",
  provider_unavailable: "settings.llm.status.providerUnavailable",
  provider_incomplete: "settings.llm.status.providerIncomplete",
  credential_missing: "settings.llm.status.credentialMissing",
  connection_unverified: "settings.llm.status.connectionUnverified",
  structured_output_unverified: "settings.llm.status.structuredOutputUnverified",
  capability_disabled: "settings.llm.status.capabilityDisabled",
};

export type BatchSecurityCheckOutcome = {
  id: string;
  label: string;
  message?: string;
  status: "succeeded" | "restricted" | "failed" | "cancelled";
};

interface BatchSecurityCheckSummaryProps {
  capability?: LlmCapabilityState;
  executableCount: number;
  kind: SecurityCheckKind;
  outcomes: BatchSecurityCheckOutcome[];
  scopeCount: number;
}

export function BatchSecurityCheckSummary({
  capability,
  executableCount,
  kind,
  outcomes,
  scopeCount,
}: BatchSecurityCheckSummaryProps): JSX.Element {
  const { t } = useTranslation();
  const succeeded = outcomes.filter((outcome) => outcome.status === "succeeded").length;
  const restricted = outcomes.filter((outcome) => outcome.status === "restricted").length;
  const failed = outcomes.filter((outcome) => outcome.status === "failed").length;
  const cancelled = outcomes.filter((outcome) => outcome.status === "cancelled").length;

  return (
    <section
      aria-labelledby="batch-security-check-heading"
      className="sh-workflow-card sh-batch-summary"
      data-testid="batch-security-check-summary"
    >
      <h2 id="batch-security-check-heading">
        {t("skillLibrary.page.batchSecurityChecks.heading", {
          kind: t(`skillLibrary.page.batchSecurityChecks.kind.${kind}`),
        })}
      </h2>
      <p className="sh-batch-summary__counts" role="status">
        {t("skillLibrary.page.batchSecurityChecks.counts", {
          scope: scopeCount,
          executable: executableCount,
          restricted,
          succeeded,
          failed,
          cancelled,
        })}
      </p>
      {kind === "llm" && capability && capability.state !== "ready" ? (
        capability.state === "error" ? (
          <p className="sh-settings-local-note" role="status">{t("settings.llm.status.readFailed")}</p>
        ) : capability.state === "blocked" ? (
          <ul className="sh-settings-local-note" role="status">
            {(capability.readiness?.reasons ?? []).map((reason) => (
              <li key={reason}>{t(CAPABILITY_REASON_KEYS[reason] as never)}</li>
            ))}
          </ul>
        ) : null
      ) : null}
      <ul className="sh-workflow-list">
        {outcomes.map((outcome) => (
          <li className="sh-workflow-list__item" key={outcome.id}>
            <div>
              <strong>{outcome.label}</strong>
              {outcome.message ? <p>{outcome.message}</p> : null}
            </div>
            <span className={`sh-status sh-status--${outcome.status === "restricted" ? "warning" : outcome.status === "cancelled" ? "skipped" : outcome.status}`}>
              {t(`skillLibrary.page.batchSecurityChecks.status.${outcome.status}`)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
