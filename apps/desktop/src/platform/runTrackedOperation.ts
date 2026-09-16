import type { QueryClient } from "@tanstack/react-query";
import { skillHubI18n } from "../i18n";
import type { AppNoticeInput, AppNotifications } from "../ui/notifications";
import {
  operationTracker,
  type BeginTrackedOperation,
  type OperationTracker,
  type TrackedResultSummary,
} from "./operationTracker";

/**
 * 统一异步执行桥（实现计划 任务 4）：一个入口同时接好
 * 1) tracker 在途投影（queued → running → 终态）；
 * 2) 后端持久化 operation id 关联（顶栏、通知中心、/operations/:id 三端同一 id）；
 * 3) useAppNotifications() 通知与深链 action；
 * 4) react-query 缓存失效。
 *
 * 边界：
 * - 「即时写入」command（单次同步响应、无后台阶段）传 mode: "instant"——
 *   不进入在途投影、不让顶栏闪烁，只给结果反馈；
 * - run 抛出的异常在完成 tracker 记账后原样 rethrow，绝不吞掉；
 * - 本模块只投影，不持久化：审计事实仍只存在于后端 operation repository。
 */

export type TrackedRunMode = "phased" | "instant";

export interface TrackedOperationHandle {
  readonly trackedId: string;
  /** 命令返回/已知持久化 operation id 时建立三端关联（默认深链 /operations/:id）。 */
  correlate: (operationId: string, targetHref?: string) => void;
  progress: (completed: number, total?: number) => void;
  phase: (message: string) => void;
  /** 执行被阻塞、需要用户显式处理时标记 needs_user。 */
  needsUser: (phase?: string) => void;
  /** 记录用户取消请求；真实取消由调用方经后端命令确认。 */
  requestCancel: () => void;
  /** 后端确认取消后调用：终态落 cancelled，后续异常按取消处理，不再记失败。 */
  markCancelled: () => void;
}

export interface RunTrackedOperationOptions<T> {
  kind: string;
  /** 已本地化的操作名（调用方负责译文，桥不再造句）。 */
  label: string;
  /** 未知总数传 0/缺省：百分比未知是合法状态。 */
  total?: number;
  parentId?: string;
  canCancel?: boolean;
  /** 命令开始前已知的持久化 operation id（如 prepared id）。 */
  operationId?: string;
  /** 覆盖默认 /operations/:id 的深链目标。 */
  targetHref?: string;
  /** "phased"（默认）占用在途顶栏；"instant" 只给结果反馈。 */
  mode?: TrackedRunMode;
  tracker?: OperationTracker;
  /** 通知服务；缺省 null 表示该流程自行反馈，桥不发通知。 */
  notifications?: AppNotifications | null;
  /** 注入翻译（测试/页面可传自己的 t）；默认全局单例。 */
  translate?: (key: string, options?: Record<string, unknown>) => string;
  /** 结果 → 通知文案钩子；返回 null 表示该结果不通知。 */
  successNotice?: (result: T, summary: TrackedResultSummary | null) => AppNoticeInput | null;
  /** 失败通知文案钩子；返回 null 表示该失败不通知。 */
  errorNotice?: (error: unknown, message: string) => AppNoticeInput | null;
  /** needs_user 阻塞通知钩子；缺省 info 级、阶段说明作 detail。 */
  needsUserNotice?: (phase: string | null) => AppNoticeInput | null;
  /** 结果 → 批量摘要（partial/failed 终态与顶栏摘要依据）。 */
  summarize?: (result: T) => TrackedResultSummary | null;
  /** 结构化 AppError → 可读文本；缺省取 Error.message。 */
  describeError?: (error: unknown) => string;
  queryClient?: QueryClient;
  invalidateQueryKeys?: ReadonlyArray<readonly unknown[]>;
  run: (handle: TrackedOperationHandle) => Promise<T>;
}

function defaultErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function defaultTranslate(key: string, options?: Record<string, unknown>): string {
  return skillHubI18n.t(key as never, options ?? {});
}

/** 无摘要时的诚实缺省：单单位成功；批量流程必须自带 summarize。 */
function defaultSummary(total: number): TrackedResultSummary {
  return { succeeded: total > 0 ? total : 1, failed: 0, skipped: 0 };
}

/** 通知缺省带“查看操作记录”深链；调用方已有 action 时不覆盖。 */
function withDeepLink(
  notice: AppNoticeInput,
  targetHref: string | null,
  translate: (key: string, options?: Record<string, unknown>) => string,
): AppNoticeInput {
  if (!targetHref || notice.action) return notice;
  return {
    ...notice,
    action: { label: translate("tasks.notices.viewRecord"), to: targetHref },
  };
}

export async function runTrackedOperation<T>(
  options: RunTrackedOperationOptions<T>,
): Promise<T> {
  const {
    kind,
    label,
    total = 0,
    parentId,
    canCancel,
    operationId,
    targetHref: initialHref,
    mode = "phased",
    tracker = operationTracker,
    notifications = null,
    translate = defaultTranslate,
    successNotice,
    errorNotice,
    needsUserNotice,
    summarize,
    describeError = defaultErrorMessage,
    queryClient,
    invalidateQueryKeys,
    run,
  } = options;

  const trackedId = mode === "phased"
    ? tracker.begin({
        canCancel,
        kind,
        label,
        operationId,
        parentId,
        targetHref: initialHref,
        total,
      } satisfies BeginTrackedOperation)
    : "";
  if (mode === "phased") {
    tracker.start(trackedId);
  }

  let correlatedHref: string | null = initialHref
    ?? (operationId ? `/operations/${operationId}` : null);
  // 用户取消经后端确认后置位：run 以异常收场时终态保持 cancelled，不记失败。
  let cancelled = false;

  const handle: TrackedOperationHandle = {
    trackedId,
    correlate(relatedOperationId, relatedHref) {
      correlatedHref = relatedHref ?? `/operations/${relatedOperationId}`;
      if (mode === "phased") {
        tracker.attach(trackedId, { operationId: relatedOperationId, targetHref: correlatedHref });
      }
    },
    progress(completed, progressTotal) {
      if (mode === "phased") tracker.progress(trackedId, completed, progressTotal);
    },
    phase(message) {
      if (mode === "phased") tracker.attach(trackedId, { phase: message });
    },
    needsUser(phase) {
      if (mode === "phased") tracker.needsUser(trackedId, phase);
      if (notifications) {
        const notice: AppNoticeInput | null = needsUserNotice
          ? needsUserNotice(phase ?? null)
          : { tone: "info", title: label, detail: phase ?? undefined };
        // 阻塞在用户动作上时立即通知，不等命令结束。
        if (notice) {
          notifications.notify(withDeepLink(notice, correlatedHref, translate));
        }
      }
    },
    requestCancel() {
      if (mode === "phased") tracker.requestCancel(trackedId);
    },
    markCancelled() {
      cancelled = true;
      if (mode === "phased") tracker.cancel(trackedId);
    },
  };

  try {
    const result = await run(handle);
    const summary = summarize ? summarize(result) : defaultSummary(total);
    if (mode === "phased") {
      tracker.complete(trackedId, summary ?? defaultSummary(total));
    }
    if (notifications) {
      const notice: AppNoticeInput | null = successNotice
        ? successNotice(result, summary)
        : {
            tone: summary && summary.failed > 0 ? "warning" : "success",
            title: label,
          };
      if (notice) {
        notifications.notify(withDeepLink(notice, correlatedHref, translate));
      }
    }
    if (queryClient && invalidateQueryKeys) {
      for (const queryKey of invalidateQueryKeys) {
        void queryClient.invalidateQueries({ queryKey: [...queryKey] });
      }
    }
    return result;
  } catch (error) {
    const message = describeError(error);
    if (mode === "phased" && !cancelled) {
      tracker.fail(trackedId, message);
    }
    if (notifications) {
      const notice: AppNoticeInput | null = errorNotice
        ? errorNotice(error, message)
        : { tone: "danger", title: label, detail: message };
      if (notice) {
        notifications.notify(withDeepLink(notice, correlatedHref, translate));
      }
    }
    // 异常不吞掉：记账完成后调用方仍拿到原始错误。
    throw error;
  }
}
