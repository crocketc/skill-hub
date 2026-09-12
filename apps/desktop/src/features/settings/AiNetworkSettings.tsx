import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../../ui/Switch";
import type { NetworkSettings, SettingsFacade } from "./api";
import { unavailableSettingsFacade } from "./api";

/** M-05：数据范围是后端偏好里的内部字符串（如 explicit_selection），
 * 不得原样渲染给用户。已知枚举映射为用户语言；未知/历史值一律回退到
 * 通用标签，绝不显示原始值。两种情况都附带一句发送范围解释。 */
export function dataScopeView(
  value: string,
  translate: (key: string) => string,
): { label: string; note: string } {
  const note = translate("settings.network.dataScopeNote");
  if (value === "explicit_selection") {
    return { label: translate("settings.network.dataScopeExplicitSelection"), note };
  }
  return { label: translate("settings.network.dataScopeGeneric"), note };
}

export function AiNetworkSettings({ settings, facade = unavailableSettingsFacade }: { settings: NetworkSettings; facade?: SettingsFacade }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(settings.networkEnabled);
  const toggle = async () => { const next = !enabled; setEnabled(next); await facade.execute({ type: "set_network_enabled", payload: { enabled: next } }); };
  const scope = dataScopeView(settings.dataScope, (key) => t(key as never));
  return (
    <section aria-labelledby="settings-network-heading" className="sh-settings-card">
      <div className="sh-section-heading">
        <div>
          <h2 id="settings-network-heading">{t("settings.network.heading")}</h2>
          <p>{t("settings.network.description")}</p>
        </div>
        <span className="sh-status sh-status--muted">
          {settings.llmProvider.trim() === "" ? t("settings.network.providerUnconfigured") : settings.llmProvider}
        </span>
      </div>
      <Switch checked={!enabled} label={t("settings.network.disableAll")} name="network-disable-all" onChange={() => void toggle()} />
      <p className="sh-settings-local-note">{t("settings.network.localStillWorks")}</p>
      <dl className="sh-facts">
        <div className="sh-settings-provider__fact">
          <dt>{t("settings.network.dataScope")}</dt>
          <dd>{scope.label}</dd>
        </div>
      </dl>
      <p className="sh-settings-local-note">{scope.note}</p>
    </section>
  );
}
