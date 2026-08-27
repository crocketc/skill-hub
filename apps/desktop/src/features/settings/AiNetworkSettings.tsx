import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { NetworkSettings, SettingsFacade } from "./api";
import { unavailableSettingsFacade } from "./api";

export function AiNetworkSettings({ settings, facade = unavailableSettingsFacade }: { settings: NetworkSettings; facade?: SettingsFacade }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(settings.networkEnabled);
  const toggle = async () => { const next = !enabled; setEnabled(next); await facade.execute({ type: "set_network_enabled", payload: { enabled: next } }); };
  return <section aria-labelledby="settings-network-heading" className="sh-settings-card"><div className="sh-section-heading"><div><h2 id="settings-network-heading">{t("settings.network.heading")}</h2><p>{t("settings.network.description")}</p></div><span className="sh-status sh-status--muted">{settings.llmProvider}</span></div><label className="sh-settings-toggle"><input aria-label={t("settings.network.disableAll")} checked={!enabled} onChange={() => void toggle()} type="checkbox" />{t("settings.network.disableAll")}</label><p className="sh-settings-local-note">{t("settings.network.localStillWorks")}</p><dl className="sh-facts"><dt>{t("settings.network.dataScope")}</dt><dd>{settings.dataScope}</dd></dl><Button onClick={() => void facade.execute({ type: "set_network_enabled", payload: { enabled: true } })} size="sm" variant="secondary">{t("settings.network.testProvider")}</Button></section>;
}
