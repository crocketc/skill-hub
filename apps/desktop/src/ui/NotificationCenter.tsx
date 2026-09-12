import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Icon } from "./Icon";
import {
  type AppNoticeTone,
  useOptionalAppNotifications,
} from "./notifications";
import "./notificationCenter.css";

/**
 * P1-11 局部通知契约（技能库等既有消费方）→ 新增01 全局通知中心的兼容桥：
 * - 在 AppNotificationsProvider 内（真实应用壳层），useNotices 的推送/撤销
 *   全部改走全局服务：toast 由 AppShell 顶部的统一栈展示（2 秒退出），
 *   本体保留在会话历史；本组件不再重复渲染局部容器（返回 null）。
 * - 无 Provider 时（独立单测/极端宿主），保留原局部实现：成功/中性 6 秒
 *   自动消退、危险常驻可关闭。
 * 新代码请直接消费 ui/notifications 的 useAppNotifications。
 */

export type NoticeTone = AppNoticeTone;

export interface NoticeInput {
  tone: NoticeTone;
  message: string;
  /** 可选展开详情（如 BatchOperationSummary）；随通知一起常驻/消退。 */
  detail?: ReactNode;
  /** 缺省时危险通知常驻、其余自动消退；显式传 true 可强制常驻（危险操作结果）。 */
  persistent?: boolean;
  /** 可选类别标签：用于在状态变化时成组撤销（如随选择变更撤销批量错误）。 */
  kind?: string;
}

export interface Notice {
  detail?: ReactNode;
  id: number | string;
  kind?: string;
  message: string;
  persistent: boolean;
  tone: NoticeTone;
}

export const NOTICE_AUTO_DISMISS_MS = 6000;

/** 原局部实现：无全局 Provider 时的回退路径（行为保持不变）。 */
function useLocalNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismissNotice = useCallback((id: number | string) => {
    if (typeof id !== "number") return;
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const pushNotice = useCallback(
    (input: NoticeInput): number => {
      nextIdRef.current += 1;
      const id = nextIdRef.current;
      const persistent = input.persistent ?? input.tone === "danger";
      setNotices((current) => [
        ...current,
        {
          detail: input.detail,
          id,
          kind: input.kind,
          message: input.message,
          persistent,
          tone: input.tone,
        },
      ]);
      if (!persistent) {
        timersRef.current.set(
          id,
          setTimeout(() => dismissNotice(id), NOTICE_AUTO_DISMISS_MS),
        );
      }
      return id;
    },
    [dismissNotice],
  );

  const dismissNoticesOfKind = useCallback((kind: string) => {
    setNotices((current) => {
      for (const notice of current) {
        if (notice.kind === kind) {
          const timer = timersRef.current.get(notice.id as number);
          if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(notice.id as number);
          }
        }
      }
      return current.filter((notice) => notice.kind !== kind);
    });
  }, []);

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
    },
    [],
  );

  return { dismissNoticesOfKind, dismissNotice, notices, pushNotice };
}

export function useNotices() {
  // 两个 hook 路径都必须无条件调用，保证 hook 顺序稳定；
  // 桥接分支是纯映射，不额外调用 hook。
  const app = useOptionalAppNotifications();
  const local = useLocalNotices();
  if (!app) {
    return local;
  }
  const { dismissByKind, dismiss, notices, notify } = app;
  return {
    dismissNoticesOfKind: dismissByKind,
    dismissNotice: (id: number | string): void => {
      dismiss(typeof id === "string" ? id : String(id));
    },
    notices: notices.map((notice) => ({
      detail: notice.detailNode,
      id: notice.id,
      kind: notice.kind,
      message: notice.title,
      persistent: false,
      tone: notice.tone,
    })),
    pushNotice: (input: NoticeInput): string =>
      notify({
        detailNode: input.detail,
        kind: input.kind,
        title: input.message,
        tone: input.tone,
      }),
  };
}

export function NotificationCenter({
  notices,
  onDismiss,
}: {
  notices: Notice[];
  onDismiss: (id: number | string) => void;
}): JSX.Element | null {
  const { t } = useTranslation();
  const bridged = useOptionalAppNotifications() !== null;
  // 键盘用户 Tab 进入通知关闭按钮后关闭通知，按钮随之卸载：
  // 把焦点送回进入通知前的宿主，避免丢焦到 body（对齐 Drawer 回退模式）。
  const focusHostRef = useRef<HTMLElement | null>(null);
  if (bridged) {
    // 全局中心（AppShell）已展示同一批通知，这里不再重复渲染局部容器。
    return null;
  }
  if (notices.length === 0) return null;
  return (
    <div
      aria-label={t("notifications.regionLabel")}
      className="sh-notification-center"
      role="region"
    >
      {notices.map((notice) => (
        <div
          aria-live={notice.tone === "danger" ? undefined : "polite"}
          className={`sh-notification sh-notification--${notice.tone}`}
          data-testid={`notice-${notice.tone}`}
          key={notice.id}
          role={notice.tone === "danger" ? "alert" : "status"}
        >
          <div className="sh-notification__body">
            <p className="sh-notification__message">{notice.message}</p>
            {notice.detail ? (
              <div className="sh-notification__detail">{notice.detail}</div>
            ) : null}
          </div>
          <Button
            aria-label={t("actions.close")}
            className="sh-notification__close"
            onFocus={(event) => {
              const related = event.relatedTarget;
              if (related instanceof HTMLElement) {
                focusHostRef.current = related;
              }
            }}
            onClick={() => {
              onDismiss(notice.id);
              focusHostRef.current?.focus();
            }}
            size="sm"
            variant="ghost"
          >
            <Icon name="close" size={16} />
          </Button>
        </div>
      ))}
    </div>
  );
}
