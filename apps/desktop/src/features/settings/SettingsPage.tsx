import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DataState } from "../../ui/DataState";
import {
  type AppUpdate,
  errorCodeOf,
  type SettingsFacade,
  type SettingsSnapshot,
  type UpdateProgress,
  type UpdateState,
  unavailableSettingsFacade,
} from "./api";
import { AiNetworkSettings } from "./AiNetworkSettings";
import { ApplicationUpdate } from "./ApplicationUpdate";
import { AutomationSettings } from "./AutomationSettings";
import { BackupSettings } from "./BackupSettings";
import { GeneralSettings } from "./GeneralSettings";
import { LibrarySettings } from "./LibrarySettings";
import { NetworkStoragePlaceholder } from "./NetworkStoragePlaceholder";
import { ViewSettings } from "./ViewSettings";

export function SettingsPage({ facade = unavailableSettingsFacade, initialSettings }: { facade?: SettingsFacade; initialSettings?: SettingsSnapshot }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SettingsSnapshot | undefined>(initialSettings);
  const [error, setError] = useState<string>();
  useEffect(() => { if (initialSettings || !facade.get) return; void facade.get().then(setSettings).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [facade, initialSettings]);
  if (error) return <DataState message={error} state="unavailable" />;
  if (!settings) return <DataState message={t("settings.loading")} state="loading" />;
  return (
    <main className="sh-page sh-settings-page">
      <header className="sh-page__header">
        <div>
          <p className="sh-eyebrow">{t("settings.eyebrow")}</p>
          <h1>{t("settings.heading")}</h1>
          <p>{t("settings.description")}</p>
        </div>
        <a href="/initialize">{t("settings.reopenOnboarding")}</a>
      </header>
      <div className="sh-settings-grid">
        <GeneralSettings facade={facade} settings={settings} />
        <LibrarySettings settings={settings} />
        <ViewSettings facade={facade} settings={settings} />
        <AutomationSettings facade={facade} settings={settings} />
        <AiNetworkSettings facade={facade} settings={settings.network} />
        <BackupSettings facade={facade.backup} settings={settings} />
        <NetworkStoragePlaceholder />
        <ApplicationUpdateCard facade={facade} settings={settings} />
      </div>
    </main>
  );
}

function ApplicationUpdateCard({ facade, settings }: { facade: SettingsFacade; settings: SettingsSnapshot }) {
  const [state, setState] = useState<UpdateState>(settings.updateState);
  const [update, setUpdate] = useState<AppUpdate | null>(settings.update);
  const [progress] = useState<UpdateProgress>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const updates = facade.updates;

  const run = (phase: UpdateState, action: () => Promise<void>) => {
    if (!updates || busy) return;
    setBusy(true);
    setState(phase);
    void action()
      .then(() => setBusy(false))
      .catch((reason: unknown) => {
        setBusy(false);
        setState("failed");
        setErrorCode(errorCodeOf(reason));
      });
  };

  return (
    <ApplicationUpdate
      busy={busy}
      buildTrust={settings.buildTrust}
      errorCode={errorCode}
      onCheck={
        updates
          ? () =>
              run("checking", async () => {
                const result = await updates.check();
                setUpdate(result);
                setState(result ? "available" : "up_to_date");
              })
          : undefined
      }
      onCancel={
        updates
          ? () =>
              run("downloading", async () => {
                await updates.cancel();
                setState("available");
              })
          : undefined
      }
      onDownload={
        updates
          ? () =>
              run("downloading", async () => {
                setState("verifying");
                await updates.download();
                setState("ready_to_install");
              })
          : undefined
      }
      onInstall={
        updates
          ? () =>
              run("ready_to_install", async () => {
                await updates.install();
              })
          : undefined
      }
      onOpenRelease={() => void facade.execute({ type: "open_official_release" })}
      onRollback={
        updates
          ? () =>
              run("ready_to_install", async () => {
                await updates.rollback();
                setState("rolled_back");
              })
          : undefined
      }
      policy={settings.updatePolicy}
      progress={progress}
      state={state}
      update={update}
    />
  );
}
