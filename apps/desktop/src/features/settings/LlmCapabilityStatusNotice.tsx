import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "../../ui/Button";
import type { LlmCapabilityBlockReason, LlmCapabilityState } from "./llmStatus";

const REASON_KEYS: Record<LlmCapabilityBlockReason, string> = {
  preconditions_missing: "settings.llm.status.preconditionsMissing",
  provider_unselected: "settings.llm.status.providerUnselected",
  provider_unavailable: "settings.llm.status.providerUnavailable",
  provider_incomplete: "settings.llm.status.providerIncomplete",
  credential_missing: "settings.llm.status.credentialMissing",
  connection_unverified: "settings.llm.status.connectionUnverified",
  structured_output_unverified: "settings.llm.status.structuredOutputUnverified",
  capability_disabled: "settings.llm.status.capabilityDisabled",
};

interface LlmCapabilityStatusNoticeProps {
  capability: LlmCapabilityState;
}

/** Shared, cause-aware status feedback for AI actions. Ready state stays quiet. */
export function LlmCapabilityStatusNotice({ capability }: LlmCapabilityStatusNoticeProps) {
  const { t } = useTranslation();
  if (capability.state === "ready") return null;

  if (capability.state === "loading") {
    return <p className="sh-settings-local-note" role="status">{t("settings.llm.status.loading")}</p>;
  }

  if (capability.state === "error") {
    return (
      <p className="sh-settings-local-note" role="status">
        {t("settings.llm.status.readFailed")}{" "}
        <Button onClick={() => void capability.query.refetch()} size="sm" variant="ghost">
          {t("settings.llm.status.retry")}
        </Button>
      </p>
    );
  }

  const reasons = capability.readiness?.reasons ?? [];
  const needsSettings = reasons.some((reason) => reason !== "preconditions_missing");
  const settingsHref = typeof window !== "undefined" && window.location.pathname.startsWith("/__preview/")
    ? "/__preview/settings-llm?section=networkAi#settings-panel-networkAi"
    : "/settings?section=networkAi#settings-panel-networkAi";
  return (
    <div className="sh-settings-local-note" role="status">
      <ul>
        {reasons.map((reason) => <li key={reason}>{t(REASON_KEYS[reason] as never)}</li>)}
      </ul>
      {needsSettings ? (
        <Link to={settingsHref}>
          {t("settings.llm.status.openSettings")}
        </Link>
      ) : null}
    </div>
  );
}
