import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type {
  AppUpdate,
  BuildTrust,
  UpdatePolicy,
  UpdateProgress,
  UpdateState,
} from "./api";
import { updateErrorKey } from "./api";

export type ApplicationUpdateProps = {
  update: AppUpdate | null;
  policy: UpdatePolicy;
  state: UpdateState;
  progress?: UpdateProgress;
  errorCode?: string | null;
  buildTrust?: BuildTrust;
  busy?: boolean;
  onCheck?: () => void;
  onDownload?: () => void;
  onInstall?: () => void;
  onCancel?: () => void;
  onRollback?: () => void;
  onOpenRelease?: () => void;
};

function percentOf(progress: UpdateProgress | undefined): number | null {
  if (!progress || progress.totalBytes == null || progress.totalBytes === 0) return null;
  return Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100));
}

export function ApplicationUpdate({
  buildTrust,
  busy = false,
  errorCode = null,
  onCancel,
  onCheck,
  onDownload,
  onInstall,
  onOpenRelease,
  onRollback,
  policy,
  progress,
  state,
  update,
}: ApplicationUpdateProps) {
  const { t } = useTranslation();
  const unsigned = buildTrust === "windows_unsigned" || buildTrust === "unknown";
  const percent = percentOf(progress);
  const installReady = state === "ready_to_install";

  return (
    <section aria-labelledby="settings-update-heading" className="sh-settings-card">
      <h2 id="settings-update-heading">{t("settings.update.heading")}</h2>
      <p>{t("settings.update.securityNotice")}</p>
      {state === "checking" ? <p>{t("settings.update.checking")}</p> : null}
      {state === "not_checked" ? <p>{t("settings.update.notChecked")}</p> : null}
      {state === "up_to_date" ? <p>{t("settings.update.current")}</p> : null}
      {state === "verifying" ? <p>{t("settings.update.verifying")}</p> : null}
      {state === "available" && update ? (
        <>
          <p>{t("settings.update.available", { version: update.version })}</p>
          {update.notes ? <p>{update.notes}</p> : null}
          <p>{unsigned ? t("settings.update.unsigned") : t("settings.update.signed")}</p>
        </>
      ) : null}
      {state === "downloading" ? (
        <>
          <p>{t("settings.update.downloading")}</p>
          <div
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent ?? undefined}
            role="progressbar"
          />
        </>
      ) : null}
      {installReady && update ? (
        <>
          <p>{t("settings.update.ready", { version: update.version })}</p>
          <p>{t("settings.update.autoRestart")}</p>
        </>
      ) : null}
      {state === "failed" ? (
        <p>{t("settings.update.failed", { message: t(`settings.update.${updateErrorKey(errorCode)}`) })}</p>
      ) : null}
      {state === "rolled_back" ? (
        <>
          <p>{t("settings.update.rolledBack")}</p>
          <p>{t("settings.update.autoRestart")}</p>
        </>
      ) : null}
      {policy.enabled ? null : <p>{t("settings.update.policyDisabled")}</p>}

      {onCheck && policy.enabled && (state === "not_checked" || state === "up_to_date") ? (
        <Button disabled={busy} onClick={onCheck}>
          {t("settings.update.check")}
        </Button>
      ) : null}

      {onDownload && (state === "available" || state === "failed" || state === "rolled_back") ? (
        <Button disabled={busy} onClick={onDownload}>
          {state === "failed" ? t("settings.update.retry") : state === "rolled_back" ? t("settings.update.reDownload") : t("settings.update.download")}
        </Button>
      ) : null}

      {onCancel && state === "downloading" ? (
        <Button disabled={busy} onClick={onCancel} variant="secondary">
          {t("settings.update.cancel")}
        </Button>
      ) : null}

      {installReady ? (
        <Button disabled={busy} onClick={onInstall}>
          {t("settings.update.install")}
        </Button>
      ) : null}

      {onRollback && state === "failed" ? (
        <Button disabled={busy} onClick={onRollback} variant="secondary">
          {t("settings.update.rollback")}
        </Button>
      ) : null}

      {onOpenRelease && (state === "available" || state === "failed" || state === "rolled_back") ? (
        <Button disabled={busy} onClick={onOpenRelease} variant="secondary">
          {t("settings.update.openRelease")}
        </Button>
      ) : null}

      {installReady && (update?.assetUrl || update?.sha256) ? (
        <details>
          <summary>{t("settings.update.details")}</summary>
          {update?.assetUrl ? (
            <p>
              <span>{t("settings.update.detailsSource")}</span> {update.assetUrl}
            </p>
          ) : null}
          {update?.sha256 ? (
            <p>
              <span>{t("settings.update.detailsHash")}</span> {update.sha256}
            </p>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}
