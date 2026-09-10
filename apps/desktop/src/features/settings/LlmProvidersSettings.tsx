import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import {
  type ConnectionTestResult,
  type LlmAdminFacade,
  type LlmProviderDraft,
  type LlmProviderPreset,
  type LlmProviderView,
  unavailableLlmFacade,
} from "./llmApi";

const EMPTY_DRAFT: LlmProviderDraft = {
  id: "",
  label: "",
  protocol: "open_ai_compatible",
  deployment: "online",
  endpoint: "",
  model: "",
  credential: null,
};

type ConnectionReport = { providerId: string; result: ConnectionTestResult };

type FieldErrors = { endpoint?: string; id?: string; model?: string };

/** Provider administration card: presets, credential entry, model fetch, the
 * two-level connection test and enable/default/delete. Credential values live
 * only in this form until they are handed to the OS credential store. */
export function LlmProvidersSettings({ facade = unavailableLlmFacade }: { facade?: LlmAdminFacade }) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<LlmProviderView[]>();
  const [presets, setPresets] = useState<LlmProviderPreset[]>();
  const [draft, setDraft] = useState<LlmProviderDraft>({ ...EMPTY_DRAFT });
  const [formOpen, setFormOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [reports, setReports] = useState<ConnectionReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [modelsUnavailable, setModelsUnavailable] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  // describeNativeError 以动态键调用翻译；i18next 的强类型键联合在此收窄。
  const describe = (reason: unknown) =>
    describeNativeError(
      reason,
      (key, options) => String(t(key as never, options as never)),
      "settings.llm.operationFailed",
    );

  const refresh = () => {
    facade
      .listProviders()
      .then(setProviders)
      .catch((reason: unknown) => setError(describe(reason)));
    facade
      .listPresets()
      .then(setPresets)
      .catch(() => setPresets([]));
  };

  useEffect(refresh, [facade]);

  const guard = (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    action()
      .then(refresh)
      .catch((reason: unknown) => setError(describe(reason)))
      .finally(() => setBusy(false));
  };

  const applyPreset = (presetId: string) => {
    const preset = presets?.find((item) => item.id === presetId);
    if (!preset) return;
    setDraft((current) => ({
      ...current,
      id: preset.id,
      label: preset.label,
      protocol: preset.protocol,
      deployment: preset.deployment,
      endpoint: preset.endpoint,
      model: "",
      credential: null,
    }));
  };

  const saveDraft = () =>
    guard(async () => {
      await facade.saveProvider(draft, draft.credential !== null);
      setFormOpen(false);
      setDraft({ ...EMPTY_DRAFT });
      setModels([]);
      setModelsUnavailable(false);
    });

  // 表单关闭原生校验气泡：WebView 的英文 "fill out this field" 不可本地化，
  // 必填约束保留（required 语义不变），缺失时改为逐字段展示本地化提示。
  const submitDraft = () => {
    const required: Array<{ key: keyof FieldErrors; label: string; value: string }> = [
      { key: "id", label: t("settings.llm.providerId"), value: draft.id },
      { key: "endpoint", label: t("settings.llm.endpoint"), value: draft.endpoint },
      { key: "model", label: t("settings.llm.model"), value: draft.model },
    ];
    const missing: FieldErrors = {};
    for (const field of required) {
      if (!field.value.trim()) {
        missing[field.key] = t("settings.llm.requiredField", { field: field.label });
      }
    }
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      return;
    }
    setFieldErrors({});
    saveDraft();
  };

  const clearFieldError = (key: keyof FieldErrors) =>
    setFieldErrors((current) => ({ ...current, [key]: undefined }));

  const fetchModels = () =>
    guard(async () => {
      try {
        setModels(await facade.fetchModels(draft));
        setModelsUnavailable(false);
      } catch (reason) {
        // 失败时保留草稿并提示可手动填写模型，不阻塞保存流程。
        setModelsUnavailable(true);
        throw reason;
      }
    });

  const testConnection = (target: LlmProviderDraft) =>
    guard(async () => {
      const result = await facade.testConnection(target);
      setReports((current) => [
        ...current.filter((report) => report.providerId !== target.id),
        { providerId: target.id, result },
      ]);
    });

  const draftOf = (view: LlmProviderView): LlmProviderDraft => ({
    id: view.config.id,
    label: view.config.label ?? view.config.id,
    protocol: view.config.protocol,
    deployment: view.config.deployment,
    endpoint: view.config.endpoint,
    model: view.config.model,
    credential: null,
  });

  return (
    <section aria-labelledby="settings-llm-providers-heading" className="sh-settings-card">
      <div className="sh-section-heading">
        <div>
          <h2 id="settings-llm-providers-heading">{t("settings.llm.providersHeading")}</h2>
          <p>{t("settings.llm.providersDescription")}</p>
        </div>
        <button onClick={() => setFormOpen((open) => !open)} type="button">
          {formOpen ? t("settings.llm.cancel") : t("settings.llm.addProvider")}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {formOpen ? (
        <form
          aria-label={t("settings.llm.formHeading")}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submitDraft();
          }}
        >
          <h3>{t("settings.llm.formHeading")}</h3>
          <label className="sh-settings-field">
            <span>{t("settings.llm.preset")}</span>
            <select
              aria-label={t("settings.llm.preset")}
              onChange={(event) => applyPreset(event.target.value)}
              value=""
            >
              <option value="">{t("settings.llm.presetPlaceholder")}</option>
              {(presets ?? []).map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <label className="sh-settings-field">
            <span>{t("settings.llm.providerId")}</span>
            <input
              aria-label={t("settings.llm.providerId")}
              onChange={(event) => {
                setDraft({ ...draft, id: event.target.value });
                clearFieldError("id");
              }}
              required
              value={draft.id}
            />
            {fieldErrors.id ? <p role="alert">{fieldErrors.id}</p> : null}
          </label>
          <label className="sh-settings-field">
            <span>{t("settings.llm.displayName")}</span>
            <input
              aria-label={t("settings.llm.displayName")}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              value={draft.label}
            />
          </label>
          <label className="sh-settings-field">
            <span>{t("settings.llm.endpoint")}</span>
            <input
              aria-label={t("settings.llm.endpoint")}
              inputMode="url"
              onChange={(event) => {
                setDraft({ ...draft, endpoint: event.target.value });
                clearFieldError("endpoint");
              }}
              required
              value={draft.endpoint}
            />
            {fieldErrors.endpoint ? <p role="alert">{fieldErrors.endpoint}</p> : null}
          </label>
          <label className="sh-settings-field">
            <span>{t("settings.llm.model")}</span>
            <input
              aria-label={t("settings.llm.model")}
              list="llm-model-options"
              onChange={(event) => {
                setDraft({ ...draft, model: event.target.value });
                clearFieldError("model");
              }}
              required
              value={draft.model}
            />
            <datalist id="llm-model-options">
              {models.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            {fieldErrors.model ? <p role="alert">{fieldErrors.model}</p> : null}
            {modelsUnavailable ? (
              <p className="sh-settings-local-note" role="status">
                {t("settings.llm.fetchModelsFailedHint")}
              </p>
            ) : null}
          </label>
          <button disabled={busy} onClick={() => void fetchModels()} type="button">
            {t("settings.llm.fetchModels")}
          </button>
          <label className="sh-settings-field">
            <span>{t("settings.llm.credential")}</span>
            <input
              aria-label={t("settings.llm.credential")}
              autoComplete="off"
              onChange={(event) =>
                setDraft({ ...draft, credential: event.target.value === "" ? null : event.target.value })
              }
              type="password"
              value={draft.credential ?? ""}
            />
          </label>
          <p className="sh-settings-local-note">{t("settings.llm.credentialNote")}</p>
          <button disabled={busy} type="submit">
            {t("settings.llm.save")}
          </button>
          <button disabled={busy} onClick={() => void testConnection(draft)} type="button">
            {t("settings.llm.testDraft")}
          </button>
        </form>
      ) : null}
      <ul className="sh-llm-providers">
        {(providers ?? []).map((view) => {
          const report = reports.find((item) => item.providerId === view.config.id);
          return (
            <li key={view.config.id}>
              <div>
                <strong>{view.config.label ?? view.config.id}</strong>{" "}
                {view.is_default ? (
                  <span className="sh-llm-badge">{t("settings.llm.defaultBadge")}</span>
                ) : null}{" "}
                <span className="sh-status sh-status--muted">
                  {view.config.deployment === "local"
                    ? t("settings.llm.localBadge")
                    : t("settings.llm.onlineBadge")}
                </span>
              </div>
              <p>{view.config.model}</p>
              <p>
                {view.credential_configured
                  ? t("settings.llm.credentialConfigured")
                  : t("settings.llm.credentialMissing")}
              </p>
              {report ? (
                <p aria-live="polite">
                  <span>
                    {report.result.endpoint.reachable
                      ? `${t("settings.llm.endpointOk")}${
                          report.result.endpoint.latency_ms !== null &&
                          report.result.endpoint.latency_ms !== undefined
                            ? ` (${report.result.endpoint.latency_ms} ms)`
                            : ""
                        }`
                      : t("settings.llm.endpointFailed")}
                  </span>
                  {" · "}
                  <span>
                    {report.result.model?.ok === true
                      ? t("settings.llm.modelOk")
                      : t("settings.llm.modelFailed", {
                          code: report.result.model_failure_code ?? "unknown",
                        })}
                  </span>
                </p>
              ) : null}
              <div>
                <button
                  disabled={busy}
                  onClick={() => void testConnection(draftOf(view))}
                  type="button"
                >
                  {t("settings.llm.testConnection")}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    guard(() => facade.setProviderEnabled(view.config.id, !view.config.enabled))
                  }
                  type="button"
                >
                  {view.config.enabled ? t("settings.llm.disable") : t("settings.llm.enable")}
                </button>
                {!view.is_default ? (
                  <button
                    disabled={busy}
                    onClick={() => guard(() => facade.setDefaultProvider(view.config.id))}
                    type="button"
                  >
                    {t("settings.llm.setDefault")}
                  </button>
                ) : null}
                <button
                  disabled={busy}
                  onClick={() => guard(() => facade.deleteProvider(view.config.id))}
                  type="button"
                >
                  {t("settings.llm.delete")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {providers && providers.length === 0 ? <p>{t("settings.llm.emptyProviders")}</p> : null}
    </section>
  );
}
