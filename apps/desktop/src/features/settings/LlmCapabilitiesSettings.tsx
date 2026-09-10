import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";
import {
  type LlmAdminFacade,
  type LlmCapabilityState,
  unavailableLlmFacade,
} from "./llmApi";

const CAPABILITY_KEYS = [
  { key: "safety_check", scopeKey: "scopeSafety" },
  { key: "semantic_duplicate", scopeKey: "scopeDuplicate" },
  { key: "description_translation", scopeKey: "scopeTranslation" },
  { key: "online_search_assist", scopeKey: "scopeSearch" },
] as const;

type CapabilityKey = (typeof CAPABILITY_KEYS)[number]["key"];

/** Capability switches default to off: no LLM call may happen that the user
 * has not opted into. Each switch shows exactly what data leaves the device. */
export function LlmCapabilitiesSettings({ facade = unavailableLlmFacade }: { facade?: LlmAdminFacade }) {
  const { t } = useTranslation();
  const [state, setState] = useState<LlmCapabilityState | undefined>(undefined);
  const [error, setError] = useState<string>();

  useEffect(() => {
    facade
      .readCapabilityState()
      .then(setState)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [facade]);

  const update = (patch: Partial<LlmCapabilityState>) => {
    if (!state) return;
    const next = { ...state, ...patch };
    setState(next);
    facade
      .writeCapabilityState(next)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  return (
    <section aria-labelledby="settings-llm-capabilities-heading" className="sh-settings-card">
      <div className="sh-section-heading">
        <div>
          <h2 id="settings-llm-capabilities-heading">{t("settings.llm.capabilitiesHeading")}</h2>
          <p>{t("settings.llm.capabilitiesDescription")}</p>
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {!state && !error ? <p>{t("settings.loading")}</p> : null}
      {state ? (
        <div className="sh-settings-capabilities">
          {CAPABILITY_KEYS.map(({ key, scopeKey }) => (
            <div className="sh-settings-capability" key={key}>
              <Switch
                checked={Boolean(state.capabilities[key as CapabilityKey])}
                label={t(`settings.llm.capability.${key}`)}
                name={`llm-capability-${key}`}
                onChange={(event) =>
                  update({ capabilities: { ...state.capabilities, [key]: event.target.checked } })
                }
              />
              <p className="sh-settings-capability__scope">{t(`settings.llm.${scopeKey}`)}</p>
            </div>
          ))}
        </div>
      ) : null}
      {state ? (
        <Field label={t("settings.llm.aiOutputLanguage")}>
          <Select
            name="ai-output-language"
            onChange={(event) => update({ aiOutputLanguage: event.target.value })}
            value={state.aiOutputLanguage}
          >
            <option value="system">{t("settings.llm.languageSystem")}</option>
            <option value="zh-CN">{t("settings.llm.languageZhCN")}</option>
            <option value="en-US">{t("settings.llm.languageEnUS")}</option>
          </Select>
        </Field>
      ) : null}
      <dl className="sh-facts">
        <dt>{t("settings.llm.defaultOffline")}</dt>
        <dd>{t("settings.llm.defaultOfflineNote")}</dd>
      </dl>
    </section>
  );
}
