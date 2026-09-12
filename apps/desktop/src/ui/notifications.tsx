import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "./Button";
import { Drawer } from "./Drawer";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { StatusBadge } from "./StatusBadge";
import { usePrefersReducedMotion } from "./reducedMotion";
import "./notificationCenter.css";

/**
 * 新增01 + M-21 全局通知中心（AppShell 级单例服务）：
 * - toast 从右上进入，固定宽度、高度自适应；所有 tone（含 danger）统一
 *   在 NOTICE_TOAST_DURATION_MS（2 秒）后退出，其下方消息上移补位；
 * - 通知本体保留在本次会话历史中（错误诊断不能只活在 toast），经顶栏
 *   通知按钮打开的抽屉可滚动查看，支持 未读/全部 筛选与清空；
 * - Provider 挂在 AppShell 内层，跨路由导航存活。
 * 下游（部署/导入/移除等）统一经 useAppNotifications().notify 接线。
 */

export type AppNoticeTone = "success" | "info" | "warning" | "danger";

export interface AppNotice {
  tone: AppNoticeTone;
  /** 已本地化的用户可读标题。 */
  title: string;
  /** 可选补充说明（可读文案，不是错误码）。 */
  detail?: string;
  /** 可选跳转（react-router path），点击后关闭抽屉/toast 并导航。 */
  action?: { label: string; to: string };
}

export interface AppNoticeRecord extends AppNotice {
  id: string;
  createdAt: number;
  read: boolean;
  /** 兼容桥接字段（P1-11 局部消费迁移）：按类别成组撤销。 */
  kind?: string;
  /** 兼容桥接字段：富文本批量摘要（BatchOperationSummary）。 */
  detailNode?: ReactNode;
}

export const NOTICE_TOAST_DURATION_MS = 2000;
/** 滑出动画时长；减少动效时跳过该阶段（立即消失）。 */
export const NOTICE_TOAST_EXIT_MS = 160;

/** notify 的入参在 AppNotice 契约上放行两个可选桥接字段
 *  （P1-11 局部消费迁移用）；下游按 AppNotice 字面量调用不受影响。 */
export type AppNoticeInput = AppNotice & {
  kind?: string;
  detailNode?: ReactNode;
};

export interface AppNotifications {
  /** 发出一条通知：立即以 toast 展示并写入会话历史，返回通知 id。 */
  notify: (notice: AppNoticeInput) => string;
  /** 关闭 toast 并把该通知标记为已读（历史保留）。 */
  dismiss: (id: string) => void;
  /** 本次会话的全部通知（最新在前）。 */
  notices: ReadonlyArray<AppNoticeRecord>;
  /** 未读数量（驱动顶栏角标）。 */
  unreadCount: number;
  markAllRead: () => void;
  /** 清空会话历史与当前 toast。 */
  clear: () => void;
  /** 按兼容桥接的类别撤销一组通知（技能库批量错误随选择变更撤销）。 */
  dismissByKind: (kind: string) => void;
}

const AppNotificationsContext = createContext<AppNotifications | null>(null);

interface ToastState {
  /** 当前 toast 栈（最新在前，含正在滑出的条目）。 */
  stackIds: string[];
  /** 已过展示时长、正在播放滑出动画的 id（减少动效时不经过此阶段）。 */
  exitingIds: ReadonlySet<string>;
}

const EMPTY_TOAST_STATE: ToastState = { stackIds: [], exitingIds: new Set() };

export function AppNotificationsProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<AppNoticeRecord[]>([]);
  const [toast, setToast] = useState<ToastState>(EMPTY_TOAST_STATE);
  const nextIdRef = useRef(0);
  const timersRef = useRef(new Map<string, Array<ReturnType<typeof setTimeout>>>());
  const reducedMotion = usePrefersReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const clearTimers = useCallback((id: string) => {
    for (const timer of timersRef.current.get(id) ?? []) clearTimeout(timer);
    timersRef.current.delete(id);
  }, []);

  const removeFromToast = useCallback((id: string) => {
    setToast((current) =>
      current.stackIds.includes(id)
        ? {
            stackIds: current.stackIds.filter((stacked) => stacked !== id),
            exitingIds: current.exitingIds,
          }
        : current,
    );
  }, []);

  const startToastTimer = useCallback(
    (id: string) => {
      clearTimers(id);
      const exitTimer = setTimeout(() => {
        // 展示时长结束：减少动效→立即消失；否则保持栈位并播放滑出动画。
        if (reducedMotionRef.current) {
          removeFromToast(id);
          return;
        }
        setToast((current) =>
          current.stackIds.includes(id)
            ? { stackIds: current.stackIds, exitingIds: new Set(current.exitingIds).add(id) }
            : current,
        );
        const removalTimer = setTimeout(() => {
          timersRef.current.delete(id);
          removeFromToast(id);
        }, NOTICE_TOAST_EXIT_MS);
        timersRef.current.set(id, [removalTimer]);
      }, NOTICE_TOAST_DURATION_MS);
      timersRef.current.set(id, [exitTimer]);
    },
    [clearTimers, removeFromToast],
  );

  const dismiss = useCallback(
    (id: string) => {
      clearTimers(id);
      removeFromToast(id);
      setNotices((current) =>
        current.map((notice) =>
          notice.id === id ? { ...notice, read: true } : notice,
        ),
      );
    },
    [clearTimers, removeFromToast],
  );

  const notify = useCallback(
    (notice: AppNoticeInput): string => {
      nextIdRef.current += 1;
      const id = `notice-${nextIdRef.current}`;
      const record: AppNoticeRecord = {
        ...notice,
        id,
        createdAt: Date.now(),
        read: false,
      };
      setNotices((current) => [record, ...current]);
      setToast((current) => ({
        stackIds: [id, ...current.stackIds],
        exitingIds: current.exitingIds,
      }));
      startToastTimer(id);
      return id;
    },
    [startToastTimer],
  );

  const markAllRead = useCallback(() => {
    setNotices((current) =>
      current.map((notice) => (notice.read ? notice : { ...notice, read: true })),
    );
  }, []);

  const clear = useCallback(() => {
    for (const timers of timersRef.current.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    timersRef.current.clear();
    setToast(EMPTY_TOAST_STATE);
    setNotices([]);
  }, []);

  const dismissByKind = useCallback(
    (kind: string) => {
      setNotices((current) => {
        const removedIds = new Set(
          current.filter((notice) => notice.kind === kind).map((notice) => notice.id),
        );
        for (const id of removedIds) clearTimers(id);
        setToast((toastState) => ({
          stackIds: toastState.stackIds.filter((id) => !removedIds.has(id)),
          exitingIds: toastState.exitingIds,
        }));
        return current.filter((notice) => notice.kind !== kind);
      });
    },
    [clearTimers],
  );

  useEffect(
    () => () => {
      for (const timers of timersRef.current.values()) {
        for (const timer of timers) clearTimeout(timer);
      }
      timersRef.current.clear();
    },
    [],
  );

  const value = useMemo<AppNotifications>(() => {
    const unreadCount = notices.reduce(
      (count, notice) => (notice.read ? count : count + 1),
      0,
    );
    return {
      notify,
      dismiss,
      notices,
      unreadCount,
      markAllRead,
      clear,
      dismissByKind,
    };
  }, [clear, dismiss, dismissByKind, markAllRead, notices, notify]);

  return (
    <AppNotificationsContext.Provider value={value}>
      {children}
      <ToastRegion toast={toast} notices={notices} onDismiss={dismiss} />
    </AppNotificationsContext.Provider>
  );
}

export function useAppNotifications(): AppNotifications {
  const context = useContext(AppNotificationsContext);
  if (!context) {
    throw new Error(
      "useAppNotifications must be used within AppNotificationsProvider",
    );
  }
  return context;
}

/** 兼容桥专用：Provider 缺席时返回 null（不抛错）。新代码请用
 *  useAppNotifications。 */
export function useOptionalAppNotifications(): AppNotifications | null {
  return useContext(AppNotificationsContext);
}

/** 顶栏通知按钮：未读角标 + 打开会话历史抽屉。 */
export function NotificationBell() {
  const { t } = useTranslation();
  const { unreadCount } = useAppNotifications();
  const [open, setOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement | null>(null);
  const label =
    unreadCount > 0
      ? t("notifications.buttonWithUnread", { count: unreadCount })
      : t("notifications.buttonLabel");

  return (
    <span className="sh-notification-bell">
      <IconButton
        aria-label={label}
        icon="bell"
        label={label}
        onClick={() => setOpen(true)}
        ref={bellRef}
      />
      {unreadCount > 0 ? (
        <span aria-hidden="true" className="sh-notification-bell__badge">
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : null}
      <NotificationHistoryDrawer
        onOpenChange={setOpen}
        open={open}
        returnFocusRef={bellRef}
      />
    </span>
  );
}

const toneI18nKey = {
  success: "notifications.tones.success",
  info: "notifications.tones.info",
  warning: "notifications.tones.warning",
  danger: "notifications.tones.danger",
} as const;

/** 会话历史抽屉：筛选（未读/全部）、全部标为已读、清空。 */
export function NotificationHistoryDrawer({
  open,
  onOpenChange,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const { clear, markAllRead, notices, unreadCount } = useAppNotifications();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const visible =
    filter === "unread" ? notices.filter((notice) => !notice.read) : notices;

  return (
    <Drawer
      closeLabel={t("actions.close")}
      description={t("notifications.drawerTitle")}
      onOpenChange={onOpenChange}
      open={open}
      returnFocusRef={returnFocusRef}
      title={t("notifications.drawerTitle")}
    >
      <div className="sh-notification-history">
        <div className="sh-notification-history__controls">
          <div
            aria-label={t("notifications.drawerTitle")}
            className="sh-notification-history__filter"
            role="group"
          >
            <Button
              aria-pressed={filter === "unread"}
              onClick={() => setFilter("unread")}
              size="sm"
              variant="ghost"
            >
              {t("notifications.filterUnread")}
            </Button>
            <Button
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
              size="sm"
              variant="ghost"
            >
              {t("notifications.filterAll")}
            </Button>
          </div>
          <div className="sh-notification-history__actions">
            <Button
              disabled={unreadCount === 0}
              onClick={markAllRead}
              size="sm"
              variant="ghost"
            >
              {t("notifications.markAllRead")}
            </Button>
            <Button disabled={notices.length === 0} onClick={clear} size="sm" variant="ghost">
              {t("notifications.clearAll")}
            </Button>
          </div>
        </div>
        {visible.length === 0 ? (
          <p className="sh-notification-history__empty" role="status">
            {notices.length === 0
              ? t("notifications.emptyHistory")
              : t("notifications.emptyUnread")}
          </p>
        ) : (
          <ul className="sh-notification-history__list">
            {visible.map((notice) => (
              <li
                className={[
                  "sh-notification-history__item",
                  notice.read ? "" : "sh-notification-history__item--unread",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={notice.id}
              >
                <div className="sh-notification-history__item-head">
                  <StatusBadge tone={notice.tone}>
                    {t(toneI18nKey[notice.tone])}
                  </StatusBadge>
                  <span className="sh-notification-history__item-title">
                    {notice.title}
                  </span>
                </div>
                {notice.detail ? (
                  <p className="sh-notification-history__item-detail">{notice.detail}</p>
                ) : null}
                {notice.detailNode}
                {notice.action ? (
                  <Link
                    className="sh-notification-history__item-action"
                    onClick={() => onOpenChange(false)}
                    to={notice.action.to}
                  >
                    {notice.action.label}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}

function ToastRegion({
  notices,
  onDismiss,
  toast,
}: {
  toast: ToastState;
  notices: ReadonlyArray<AppNoticeRecord>;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  if (toast.stackIds.length === 0) {
    return null;
  }
  const byId = new Map(notices.map((notice) => [notice.id, notice]));
  return (
    <div
      aria-label={t("notifications.regionLabel")}
      className="sh-notification-center"
      data-reduced-motion={String(reducedMotion)}
      role="region"
    >
      {toast.stackIds.map((id) => {
        const notice = byId.get(id);
        if (!notice) {
          return null;
        }
        const isDanger = notice.tone === "danger";
        const exiting = toast.exitingIds.has(id);
        return (
          <div
            aria-live={isDanger ? undefined : "polite"}
            className={`sh-notification sh-notification--${notice.tone}`}
            data-state={exiting ? "exiting" : undefined}
            data-testid={`notice-${notice.tone}`}
            key={id}
            role={isDanger ? "alert" : "status"}
          >
            <div className="sh-notification__body">
              <p className="sh-notification__message" data-toast-title="">
                {notice.title}
              </p>
              {notice.detail ? (
                <p className="sh-notification__detail">{notice.detail}</p>
              ) : null}
              {notice.detailNode}
              {notice.action ? (
                <ToastActionLink action={notice.action} onDismiss={onDismiss} id={id} />
              ) : null}
            </div>
            <Button
              aria-label={t("actions.close")}
              className="sh-notification__close"
              onClick={() => onDismiss(id)}
              size="sm"
              variant="ghost"
            >
              <Icon name="close" size={16} />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function ToastActionLink({
  action,
  id,
  onDismiss,
}: {
  action: { label: string; to: string };
  id: string;
  onDismiss: (id: string) => void;
}) {
  return (
    <Link className="sh-notification__action" onClick={() => onDismiss(id)} to={action.to}>
      {action.label}
    </Link>
  );
}
