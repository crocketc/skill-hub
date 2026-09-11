/**
 * 桌面命令层通过 Tauri IPC 返回的失败有两种形状：
 * 1) 结构化 AppError 对象 `{ code, severity, params, actions }`（serde 序列化）；
 * 2) 宿主命令（如目录选择器）返回的纯字符串。
 * 前端此前把整对象直接 String()，用户看到 "[object Object]"；本模块统一
 * 解析两种形状，供各页面给出可读、含错误码的诚实反馈。
 */
export interface NativeAppError {
  code: string;
  severity: string;
  params: Record<string, unknown>;
  actions: string[];
}

export function nativeErrorCode(error: unknown): string | null {
  if (typeof error === "string") {
    const parsed = tryParseJson(error);
    if (parsed) return nativeErrorCode(parsed);
    const match = error.match(/([a-z0-9_]+\.[a-z0-9_.]+)/i);
    return match?.[1] ?? null;
  }
  if (error instanceof Error) {
    return nativeErrorCode(error.message);
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.trim() ? code : null;
  }
  return null;
}

export function nativeErrorParams(error: unknown): Record<string, unknown> {
  const fromObject = (): Record<string, unknown> | null => {
    if (typeof error === "object" && error !== null && "params" in error) {
      const params = (error as { params?: unknown }).params;
      if (typeof params === "object" && params !== null) {
        return params as Record<string, unknown>;
      }
    }
    return null;
  };
  if (typeof error === "string") {
    const parsed = tryParseJson(error);
    if (parsed) return nativeErrorParams(parsed);
    return {};
  }
  if (error instanceof Error) {
    return nativeErrorParams(error.message);
  }
  return fromObject() ?? {};
}

/**
 * 把结构化错误翻译为可读消息：已知 code/原因走专属文案；
 * 其余回退到通用文案并附上原始错误码，绝不静默、绝不显示
 * "[object Object]"。`translate` 是 i18n 的 `t`（保持本模块无 React 依赖）。
 */
export function describeNativeError(
  error: unknown,
  translate: (key: string, options?: Record<string, unknown>) => string,
  genericKey: string,
): string {
  const code = nativeErrorCode(error);
  const params = nativeErrorParams(error);
  const reason = typeof params.reason === "string" ? params.reason : undefined;

  const keyed = keyedMessage(code, reason);
  if (keyed) {
    return translate(keyed, { ...params, code: code ?? "", reason: reason ?? "" });
  }
  if (code) {
    return translate(genericKey, { code });
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return translate(genericKey, { code: "unknown" });
}

/**
 * 把错误码映射为 i18n key（不翻译）。供 describeNativeError 使用；
 * 也导出给无法直接拿到 `t` 的数据层（如 import 提交循环）把结构化
 * 错误码转成可被 `t()` 解析的 key，避免裸代码直达用户界面。
 */
export function keyedMessage(
  code: string | null,
  reason: string | undefined,
): string | null {
  if (code === "operation.conflict") {
    if (reason === "no_upstream_source") return "errors.sourceUpdate.noUpstreamConflict";
    if (reason === "source_unavailable") return "errors.sourceUpdate.sourceUnavailable";
    if (reason === "library_not_ready") return "errors.onboarding.libraryNotReady";
    if (reason === "library_root_locked") return "errors.onboarding.libraryRootLocked";
    if (reason === "existing_library_manifest_missing") return "errors.onboarding.existingLibraryManifestMissing";
    if (reason === "library_not_writable") return "errors.onboarding.libraryNotWritable";
  }
  if (code === "object.not_found") return "errors.objectNotFound";
  if (code === "network.disabled") return "errors.networkDisabled";
  if (code === "llm.not_configured") return "settings.llm.notConfigured";
  if (code === "credential.unavailable") return "settings.llm.credentialUnavailable";
  if (code === "llm.credential_read_failed") return "settings.llm.credentialReadFailed";
  if (code === "llm.endpoint_unreachable") return "settings.llm.endpointUnreachable";
  if (code === "llm.endpoint_not_allowed") return "settings.llm.endpointNotAllowed";
  if (code === "llm.auth_failed") return "settings.llm.authFailed";
  if (code === "llm.model_not_found") return "settings.llm.modelNotFound";
  if (code === "llm.rate_limited") return "settings.llm.rateLimited";
  if (code === "llm.request_timeout") return "settings.llm.requestTimeout";
  if (code === "llm.server_error") return "settings.llm.serverError";
  if (code === "llm.invalid_json") return "settings.llm.invalidJson";
  if (code === "llm.invalid_structured_response") return "settings.llm.invalidResponse";
  if (code === "llm.response_interrupted") return "settings.llm.responseInterrupted";
  if (code === "llm.cancelled") return "settings.llm.cancelled";
  if (code === "llm.protocol_incompatible") return "settings.llm.protocolIncompatible";
  if (code === "llm.capability_disabled") return "settings.llm.capabilityDisabled";
  if (code === "llm.input_too_large") return "settings.llm.inputTooLarge";
  if (code === "llm.evidence_reference_invalid") return "settings.llm.evidenceReferenceInvalid";
  if (code === "source.search_rate_limited") return "source.searchRateLimited";
  if (code === "source.provider_authentication_unavailable") return "source.providerAuthenticationUnavailable";
  if (code === "source.search_unavailable") return "source.searchUnavailable";
  if (code === "deployment.target_exists") return "deployment.results.failure.targetExists";
  if (code === "deployment.target_changed") return "deployment.results.failure.targetChanged";
  if (code === "deployment.symlink_not_supported") return "deployment.results.failure.symlinkNotSupported";
  if (code === "deployment.junction_not_supported") return "deployment.results.failure.junctionNotSupported";
  if (code === "deployment.ownership_mismatch") return "deployment.results.failure.ownershipMismatch";
  if (code === "deployment.security_check_blocked") return "deployment.results.failure.securityBlocked";
  if (code === "target.ownership_unknown") return "deployment.results.failure.ownershipUnknown";
  if (code === "agent_profile.invalid_capability") return "deployment.results.failure.invalidCapability";
  if (code === "backup.checksum_mismatch") return "errors.backupChecksumMismatch";
  if (code === "import.remote_download_not_wired") return "importWorkflow.errors.remoteNotWired";
  if (code === "import.no_default_action") return "importWorkflow.errors.noDefaultAction";
  if (code === "input.invalid") {
    // open_existing 用 input.invalid 承载“目录不是已有集中库”的原因；
    // 只有该 reason 走专属文案，其余 input.invalid 保持通用校验提示。
    if (reason === "existing_library_manifest_missing") {
      return "errors.onboarding.existingLibraryManifestMissing";
    }
    return "errors.inputInvalid";
  }
  return null;
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}
