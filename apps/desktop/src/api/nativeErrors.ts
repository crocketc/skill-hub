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
    return translate(keyed, { code: code ?? "", reason: reason ?? "" });
  }
  if (code) {
    return translate(genericKey, { code });
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return translate(genericKey, { code: "unknown" });
}

function keyedMessage(
  code: string | null,
  reason: string | undefined,
): string | null {
  if (code === "operation.conflict") {
    if (reason === "no_upstream_source") return "errors.sourceUpdate.noUpstreamConflict";
    if (reason === "source_unavailable") return "errors.sourceUpdate.sourceUnavailable";
    if (reason === "library_root_locked") return "errors.onboarding.libraryRootLocked";
  }
  if (code === "object.not_found") return "errors.objectNotFound";
  if (code === "network.disabled") return "errors.networkDisabled";
  if (code === "backup.checksum_mismatch") return "errors.backupChecksumMismatch";
  if (code === "import.remote_download_not_wired") return "importWorkflow.errors.remoteNotWired";
  if (code === "import.no_default_action") return "importWorkflow.errors.noDefaultAction";
  if (code === "input.invalid") return "errors.inputInvalid";
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
