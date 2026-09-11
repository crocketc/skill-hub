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
import { ConnectionReportList } from "./ConnectionReportList";
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

type EditorState = { mode: "add" } | { mode: "edit"; id: string; credentialConfigured: boolean } | null;

/** P1-03 前置就绪状态：端点 → 密钥 → 动作（获取模型/测试）。与
 * llmApi.deploymentNeedsNoCredential 同一规则：local 部署豁免密钥。 */
type DraftPrereq =
  | { stage: "idle"; missing: "endpoint" }
  | { stage: "endpoint_ready"; missing: "credential" }
  | { stage: "ready" };

/** 抽屉内动作的进行中/结果/失败状态：测试结果必须在抽屉内渲染（此前
 * 只写入已保存供应商行，抽屉里点了“测试此配置”没有任何反馈）。 */
type DraftActionState =
  | { kind: "idle" }
  | { kind: "fetchingModels" }
  | { kind: "testing" }
  | { kind: "tested"; report: ConnectionTestResult }
  | { kind: "actionFailed"; message: string };

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
  const [notice, setNotice] = useState<string>();
  const [modelsUnavailable, setModelsUnavailable] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [draftAction, setDraftAction] = useState<DraftActionState>({ kind: "idle" });
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
    setNotice(undefined);
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
    setDraftAction({ kind: "idle" });
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
    setEditor({ mode: "edit", id: view.config.id, credentialConfigured: view.credential_configured === true });
  };

  // 关闭即清空草稿：凭据、端点等输入不残留在 DOM 中。
  const closeEditor = () => {
    setEditor(null);
    resetEditorForm();
  };

  const applyPreset = (presetId: string) => {
    const preset = presets?.find((item) => item.id === presetId);
    if (!preset) return;
    clearStaleDraftResult();
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

  const clearCredential = (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    facade
      .clearCredential(id)
      .then(() => {
        setNotice(t("settings.llm.credentialCleared"));
        refresh();
      })
      .catch((reason: unknown) => setError(describe(reason)))
      .finally(() => setBusy(false));
  };

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

  // 端点/密钥/部署方式变化后，旧的测试结果/失败信息不再可信。
  const clearStaleDraftResult = () =>
    setDraftAction((current) =>
      current.kind === "tested" || current.kind === "actionFailed" ? { kind: "idle" } : current,
    );

  // P1-03 前置就绪判定（与 llmApi.deploymentNeedsNoCredential 同一规则）：
  // 缺端点 → idle；在线部署且无任何密钥来源 → endpoint_ready；其余 ready
  // （local 豁免密钥；编辑留空 = 沿用已存凭据）。
  const hasCredentialSource =
    draft.credential !== null ||
    (editor?.mode === "edit" && editor.credentialConfigured);
  const draftPrereq: DraftPrereq =
    draft.endpoint.trim() === ""
      ? { stage: "idle", missing: "endpoint" }
      : draft.deployment !== "local" && !hasCredentialSource
        ? { stage: "endpoint_ready", missing: "credential" }
        : { stage: "ready" };
  const draftActionsReady = draftPrereq.stage === "ready";
  const prereqHint =
    draftPrereq.stage === "ready"
      ? undefined
      : draftPrereq.missing === "endpoint"
        ? t("settings.llm.prereqEndpointNeeded")
        : t("settings.llm.prereqCredentialNeeded");

  // 抽屉动作失败时信息渲染在抽屉内（role=alert）；卡片级 error 留给行级操作。
  const fetchModels = () => {
    if (busy || !draftActionsReady) return;
    setDraftAction({ kind: "fetchingModels" });
    guard(async () => {
      try {
        setModels(await facade.fetchModels(draft));
        setModelsUnavailable(false);
        setDraftAction({ kind: "idle" });
      } catch (reason) {
        // 失败时保留草稿并提示可手动填写模型，不阻塞保存流程。
        setModelsUnavailable(true);
        setDraftAction({ kind: "actionFailed", message: describe(reason) });
      }
    });
  };

  const testDraft = () => {
    if (busy || !draftActionsReady) return;
    setDraftAction({ kind: "testing" });
    guard(async () => {
      try {
        const result = await facade.testConnection(draft);
        setDraftAction({ kind: "tested", report: result });
      } catch (reason) {
        setDraftAction({ kind: "actionFailed", message: describe(reason) });
      }
    });
  };

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
      {notice ? <p role="status">{notice}</p> : null}
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
                clearStaleDraftResult();
                setDraft({ ...draft, endpoint: event.target.value });
                clearFieldError("endpoint");
              }}
              required
              value={draft.endpoint}
            />
          </Field>
          {/* P1-03：密钥紧跟 API 地址（验收原话“API秘钥输入框放到API地址下面”）。 */}
          <Field help={t("settings.llm.credentialNote")} label={t("settings.llm.credential")}>
            <Input
              autoComplete="new-password"
              name="provider-credential"
              onChange={(event) => {
                clearStaleDraftResult();
                setDraft({ ...draft, credential: event.target.value === "" ? null : event.target.value });
              }}
              type="password"
              value={draft.credential ?? ""}
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
          {/* P1-03 状态机：前置不足时禁用并解释（常驻帮助文本 + title）。 */}
          {prereqHint ? (
            <p className="sh-settings-local-note" id="llm-draft-prereq-hint">
              {prereqHint}
            </p>
          ) : null}
          <div className="sh-settings-form-actions">
            <Button
              aria-describedby={prereqHint ? "llm-draft-prereq-hint" : undefined}
              disabled={busy || !draftActionsReady}
              onClick={() => void fetchModels()}
              title={prereqHint}
              variant="secondary"
            >
              {t("settings.llm.fetchModels")}
            </Button>
            <Button
              aria-describedby={prereqHint ? "llm-draft-prereq-hint" : undefined}
              disabled={busy || !draftActionsReady}
              onClick={testDraft}
              title={prereqHint}
              variant="secondary"
            >
              {t("settings.llm.testDraft")}
            </Button>
          </div>
          {draftAction.kind === "fetchingModels" || draftAction.kind === "testing" ? (
            <p className="sh-settings-local-note" role="status">
              {draftAction.kind === "fetchingModels"
                ? t("settings.llm.fetchingModels")
                : t("settings.llm.testingDraft")}
            </p>
          ) : null}
          {draftAction.kind === "actionFailed" ? (
            <p className="sh-settings-local-note" role="alert">
              {draftAction.message}
            </p>
          ) : null}
          {draftAction.kind === "tested" ? (
            <div className="sh-settings-draft-report">
              <p className="sh-settings-draft-report__label">{t("settings.llm.draftReportLabel")}</p>
              <ConnectionReportList report={draftAction.report} />
            </div>
          ) : null}
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
              onClearCredential={() => clearCredential(view.config.id)}
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
