import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Icon } from "../../ui/Icon";
import { StatusBadge } from "../../ui/StatusBadge";
import type { ConnectionTestResult, LlmProviderView } from "./llmApi";

interface LlmProviderRowProps {
  busy: boolean;
  onClearCredential: () => void;
  onDelete: () => void;
  onEdit: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onSetDefault: () => void;
  onTest: () => void;
  onToggleEnabled: () => void;
  report?: ConnectionTestResult;
  view: LlmProviderView;
}

/**
 * Full-width provider entity row (design spec 5.1): identity, type, endpoint,
 * model, enabled state, default marker and credential status stay visible in
 * one row; the two-level connection result renders in its own status area.
 */
export function LlmProviderRow({
  busy,
  onClearCredential,
  onDelete,
  onEdit,
  onSetDefault,
  onTest,
  onToggleEnabled,
  report,
  view,
}: LlmProviderRowProps) {
  const { t } = useTranslation();
  const isLocal = view.config.deployment === "local";

  return (
    <li className="sh-settings-provider">
      <div className="sh-settings-provider__head">
        <strong className="sh-settings-provider__name">
          {view.config.label ?? view.config.id}
        </strong>
        <StatusBadge tone="info">
          {isLocal ? t("settings.llm.localBadge") : t("settings.llm.onlineBadge")}
        </StatusBadge>
        <StatusBadge tone={view.config.enabled ? "success" : "neutral"}>
          {view.config.enabled ? t("settings.llm.enabledBadge") : t("settings.llm.disabledBadge")}
        </StatusBadge>
        {view.is_default ? (
          <StatusBadge tone="warning">{t("settings.llm.defaultBadge")}</StatusBadge>
        ) : null}
      </div>
      <dl className="sh-settings-provider__facts">
        <div className="sh-settings-provider__fact">
          <dt>{t("settings.llm.endpoint")}</dt>
          <dd className="sh-settings-provider__mono">{view.config.endpoint}</dd>
        </div>
        <div className="sh-settings-provider__fact">
          <dt>{t("settings.llm.model")}</dt>
          <dd className="sh-settings-provider__mono">{view.config.model}</dd>
        </div>
        <div className="sh-settings-provider__fact">
          <dt>{t("settings.llm.credentialStatus")}</dt>
          <dd>
            {view.credential_configured
              ? t("settings.llm.credentialConfigured")
              : t("settings.llm.credentialMissing")}
          </dd>
        </div>
      </dl>
      {report ? (
        <ul aria-live="polite" className="sh-settings-provider__report">
          <li
            className={`sh-settings-provider__level${
              report.endpoint.reachable ? " sh-settings-provider__level--ok" : ""
            }`}
          >
            <Icon
              className="sh-settings-provider__level-icon"
              name={report.endpoint.reachable ? "success" : "failure"}
              size={16}
            />
            <span>
              {report.endpoint.reachable
                ? `${t("settings.llm.endpointOk")}${
                    report.endpoint.latency_ms !== null &&
                    report.endpoint.latency_ms !== undefined
                      ? ` (${report.endpoint.latency_ms} ms)`
                      : ""
                  }`
                : t("settings.llm.endpointFailed")}
            </span>
          </li>
          <li
            className={`sh-settings-provider__level${
              report.model?.ok === true ? " sh-settings-provider__level--ok" : ""
            }`}
          >
            <Icon
              className="sh-settings-provider__level-icon"
              name={report.model?.ok === true ? "success" : "failure"}
              size={16}
            />
            <span>
              {report.model?.ok === true
                ? t("settings.llm.modelOk")
                : report.model_failure_code
                  ? describeNativeError(
                      {
                        code: report.model_failure_code,
                        severity: "error",
                        params: {},
                        actions: [],
                      },
                      (key, options) => String(t(key as never, options as never)),
                      "settings.llm.modelFailed",
                    )
                  : t("settings.llm.modelFailed", { code: "unknown" })}
            </span>
          </li>
        </ul>
      ) : null}
      <div className="sh-settings-provider__actions">
        <Button disabled={busy} onClick={onTest} size="sm" variant="secondary">
          {t("settings.llm.testConnection")}
        </Button>
        <Button disabled={busy} onClick={onToggleEnabled} size="sm" variant="secondary">
          {view.config.enabled ? t("settings.llm.disable") : t("settings.llm.enable")}
        </Button>
        {!view.is_default ? (
          <Button disabled={busy} onClick={onSetDefault} size="sm" variant="secondary">
            {t("settings.llm.setDefault")}
          </Button>
        ) : null}
        <Button disabled={busy} onClick={onEdit} size="sm" variant="secondary">
          {t("settings.llm.edit")}
        </Button>
        {view.credential_configured ? (
          <ConfirmDialog
            cancelLabel={t("settings.llm.cancel")}
            confirmLabel={t("settings.llm.clearCredential")}
            description={t("settings.llm.clearCredentialConfirmDescription", {
              label: view.config.label ?? view.config.id,
            })}
            onConfirm={onClearCredential}
            title={t("settings.llm.clearCredentialConfirmTitle")}
            trigger={
              <Button disabled={busy} size="sm" variant="secondary">
                {t("settings.llm.clearCredential")}
              </Button>
            }
          />
        ) : null}
        <ConfirmDialog
          cancelLabel={t("settings.llm.cancel")}
          confirmLabel={t("settings.llm.delete")}
          description={t("settings.llm.deleteConfirmDescription", {
            label: view.config.label ?? view.config.id,
          })}
          onConfirm={onDelete}
          title={t("settings.llm.deleteConfirmTitle")}
          trigger={
            <Button disabled={busy} size="sm" variant="danger">
              {t("settings.llm.delete")}
            </Button>
          }
        />
      </div>
    </li>
  );
}
