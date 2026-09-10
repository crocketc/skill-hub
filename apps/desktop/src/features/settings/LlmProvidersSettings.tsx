import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { Drawer } from "../../ui/Drawer";
import { Field } from "../../ui/Field";
import { focusFirstInvalidField } from "../../ui/focusFirstInvalidField";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import {
  type ConnectionTestResult,
  type LlmAdminFacade,
  type LlmProviderDraft,
  type LlmProviderPreset,
  type LlmProviderView,
  unavailableLlmFacade,
} from "./llmApi";
import { LlmProviderRow } from "./LlmProviderRow";

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

type EditorState = { mode: "add" } | { mode: "edit"; id: string } | null;

/** Provider administration section: full-width entity rows, an add/edit drawer,
 * credential entry, model fetch, the two-level connection test and
 * enable/default/delete. Credential values live only in this form until they
 * are handed to the OS credential store; edits never echo the stored key. */
export function LlmProvidersSettings({ facade = unavailableLlmFacade }: { facade?: LlmAdminFacade }) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<LlmProviderView[]>();
  const [presets, setPresets] = useState<LlmProviderPreset[]>();
  const [draft, setDraft] = useState<LlmProviderDraft>({ ...EMPTY_DRAFT });
  const [editor, setEditor] = useState<EditorState>(null);
  const [models, setModels] = useState<string[]>([]);
  const [reports, setReports] = useState<ConnectionReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [modelsUnavailable, setModelsUnavailable] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);

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

  const resetEditorForm = () => {
    setDraft({ ...EMPTY_DRAFT });
    setModels([]);
    setModelsUnavailable(false);
    setFieldErrors({});
  };

  const openAdd = (event: React.MouseEvent<HTMLButtonElement>) => {
    returnFocusRef.current = event.currentTarget;
    resetEditorForm();
    setEditor({ mode: "add" });
  };

  const openEdit = (view: LlmProviderView, event: React.MouseEvent<HTMLButtonElement>) => {
    returnFocusRef.current = event.currentTarget;
    resetEditorForm();
    setDraft(draftOf(view));
    setEditor({ mode: "edit", id: view.config.id });
  };

  // 关闭即清空草稿：凭据、端点等输入不残留在 DOM 中。
  const closeEditor = () => {
    setEditor(null);
    resetEditorForm();
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
      closeEditor();
    });

  // 表单关闭原生校验气泡：WebView 的英文 "fill out this field" 不可本地化，
  // 必填约束保留（required 语义不变），缺失时改为逐字段展示本地化提示，
  // 并把键盘焦点移动到第一个无效字段（设计规格 4.1）。
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

  // 焦点移动必须发生在逐字段错误提交渲染之后，因此放在 effect 中。
  useEffect(() => {
    if (Object.keys(fieldErrors).length > 0) {
      focusFirstInvalidField();
    }
  }, [fieldErrors]);

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
        <Button onClick={openAdd} variant="primary">
          {t("settings.llm.addProvider")}
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <Drawer
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        open={editor !== null}
        returnFocusRef={returnFocusRef}
        title={editor?.mode === "edit" ? t("settings.llm.editHeading") : t("settings.llm.formHeading")}
      >
        <form
          aria-label={t("settings.llm.formHeading")}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submitDraft();
          }}
        >
          {editor?.mode === "add" ? (
            <Field label={t("settings.llm.preset")}>
              <Select
                name="provider-preset"
                onChange={(event) => applyPreset(event.target.value)}
                value=""
              >
                <option value="">{t("settings.llm.presetPlaceholder")}</option>
                {(presets ?? []).map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field
            error={fieldErrors.id}
            label={t("settings.llm.providerId")}
            required
          >
            <Input
              autoComplete="off"
              disabled={editor?.mode === "edit"}
              name="provider-id"
              onChange={(event) => {
                setDraft({ ...draft, id: event.target.value });
                clearFieldError("id");
              }}
              required
              value={draft.id}
            />
          </Field>
          <Field label={t("settings.llm.displayName")}>
            <Input
              autoComplete="off"
              name="provider-label"
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              value={draft.label}
            />
          </Field>
          <Field
            error={fieldErrors.endpoint}
            label={t("settings.llm.endpoint")}
            required
          >
            <Input
              autoComplete="off"
              inputMode="url"
              name="provider-endpoint"
              onChange={(event) => {
                setDraft({ ...draft, endpoint: event.target.value });
                clearFieldError("endpoint");
              }}
              required
              value={draft.endpoint}
            />
          </Field>
          <Field
            error={fieldErrors.model}
            label={t("settings.llm.model")}
            required
          >
            <Input
              autoComplete="off"
              list="llm-model-options"
              name="provider-model"
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
          </Field>
          {modelsUnavailable ? (
            <p className="sh-settings-local-note" role="status">
              {t("settings.llm.fetchModelsFailedHint")}
            </p>
          ) : null}
          <div className="sh-settings-form-actions">
            <Button disabled={busy} onClick={() => void fetchModels()} variant="secondary">
              {t("settings.llm.fetchModels")}
            </Button>
            <Button disabled={busy} onClick={() => void testConnection(draft)} variant="secondary">
              {t("settings.llm.testDraft")}
            </Button>
          </div>
          <Field help={t("settings.llm.credentialNote")} label={t("settings.llm.credential")}>
            <Input
              autoComplete="new-password"
              name="provider-credential"
              onChange={(event) =>
                setDraft({ ...draft, credential: event.target.value === "" ? null : event.target.value })
              }
              type="password"
              value={draft.credential ?? ""}
            />
          </Field>
          <div className="sh-settings-form-actions">
            <Button disabled={busy} onClick={closeEditor} variant="ghost">
              {t("settings.llm.cancel")}
            </Button>
            <Button disabled={busy} type="submit">
              {t("settings.llm.save")}
            </Button>
          </div>
        </form>
      </Drawer>
      <ul className="sh-settings-providers">
        {(providers ?? []).map((view) => {
          const report = reports.find((item) => item.providerId === view.config.id)?.result;
          return (
            <LlmProviderRow
              busy={busy}
              key={view.config.id}
              onDelete={() => guard(() => facade.deleteProvider(view.config.id))}
              onEdit={(event) => openEdit(view, event)}
              onSetDefault={() => guard(() => facade.setDefaultProvider(view.config.id))}
              onTest={() => void testConnection(draftOf(view))}
              onToggleEnabled={() =>
                guard(() => facade.setProviderEnabled(view.config.id, !view.config.enabled))
              }
              report={report}
              view={view}
            />
          );
        })}
      </ul>
      {providers && providers.length === 0 ? <p>{t("settings.llm.emptyProviders")}</p> : null}
    </section>
  );
}
