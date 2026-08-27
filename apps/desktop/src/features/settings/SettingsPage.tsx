import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DataState } from "../../ui/DataState";
import { type SettingsFacade, type SettingsSnapshot, unavailableSettingsFacade } from "./api";
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
  return <main className="sh-page sh-settings-page"><header className="sh-page__header"><div><p className="sh-eyebrow">{t("settings.eyebrow")}</p><h1>{t("settings.heading")}</h1><p>{t("settings.description")}</p></div></header><div className="sh-settings-grid"><GeneralSettings settings={settings} /><LibrarySettings settings={settings} /><ViewSettings settings={settings} /><AutomationSettings settings={settings} /><AiNetworkSettings facade={facade} settings={settings.network} /><BackupSettings settings={settings} /><NetworkStoragePlaceholder /><ApplicationUpdate buildTrust={settings.buildTrust} facade={facade} update={settings.update} /></div></main>;
}
