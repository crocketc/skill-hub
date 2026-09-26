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
import { createPortal } from "react-dom";
import { Link, useInRouterContext } from "react-router-dom";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { useSkillHubReducedMotion } from "./reducedMotion";
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

/**
 * DEV-92（2026-09-25 验收反馈）：通知按功能域分组展示（用户裁决：按功能域，
 * 不按品牌/Skill）。source 是展示语义字段——分组、组图标、组名；撤销用的
 * `kind` 桥接字段不承担展示语义，两者不混用。缺省归入 "system"。
 */
export type NoticeSource =
  | "library"
  | "deployment"
  | "import"
  | "discovery"
  | "governance"
  | "system";

export interface AppNotice {
  tone: AppNoticeTone;
  /** 已本地化的用户可读标题。 */
  title: string;
  /** 可选补充说明（可读文案，不是错误码）。 */
  detail?: string;
  /** 可选跳转（react-router path），点击后关闭抽屉/toast 并导航。 */
  action?: { label: string; to: string };
  /** 功能域分组（DEV-92）；缺省 system。 */
  source?: NoticeSource;
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
  /** 只把该条通知标记为已读（历史保留；不影响仍在展示的 toast）。
   *  幂等：对已读或不存在 id 重复调用是空操作。 */
  markRead: (id: string) => void;
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
  const reducedMotion = useSkillHubReducedMotion();
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

  // 历史抽屉的“已读”入口：只改 read 标记，不清计时器、不移除 toast
  // （toast 有自己的 2 秒生命周期，抽屉交互不应挪动它）；未命中的 id
  // 与已读条目保持原对象引用，重复调用可安全短路。
  const markRead = useCallback((id: string) => {
    setNotices((current) =>
      current.map((notice) =>
        notice.id === id && !notice.read ? { ...notice, read: true } : notice,
      ),
    );
  }, []);

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
      markRead,
      notices,
      unreadCount,
      markAllRead,
      clear,
      dismissByKind,
    };
  }, [clear, dismiss, dismissByKind, markAllRead, markRead, notices, notify]);

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
        onClick={() => setOpen((currentOpen) => !currentOpen)}
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

/** 通知卡片时间：今天显 HH:mm，今年显 M/D，跨年显 YYYY/M/D。 */
function formatNoticeTime(createdAt: number, language: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(language, { month: "numeric", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

/** DEV-96：功能域徽标——每张历史卡片标注通知所属模块（缺省系统），
 * 与展开态分组使用同一套本地化文案，折叠态也能回答「属于哪个模块」。 */
function NoticeSourceBadge({ source }: { source: NoticeSource }) {
  const { t } = useTranslation();
  return (
    <span className="sh-notification-popover__source">{t(`notifications.sources.${source}`)}</span>
  );
}

/**
 * DEV-92 透明浮层（替代右侧全高抽屉）：贴齐顶栏下方和窗口右侧，
 * 打开时由右向左滑入、关闭时向右滑出；折叠态展示层叠卡片（最新一条
 * 完整 + 至多两条上缘），可展开为按功能域分组的完整历史（未读/全部筛选、
 * 全部标已读、清空能力保留）。消息本体激活仍先标已读再收起浮层。
 */
export function NotificationHistoryDrawer({
  open,
  onOpenChange,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t, i18n } = useTranslation();
  const { clear, markAllRead, markRead, notices, unreadCount } = useAppNotifications();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<"closed" | "entering" | "open" | "closing">("closed");
  const reducedMotion = useSkillHubReducedMotion();

  // 进入/退出都由 CSS keyframes 驱动；退出动画结束事件负责卸载。
  // 减少动效时直接进入/退出终态。
  useEffect(() => {
    if (open) {
      if (reducedMotion) {
        setPhase("open");
      } else {
        setPhase("entering");
      }
      return undefined;
    }
    if (reducedMotion) setPhase("closed");
    else setPhase((current) => current === "closed" || current === "closing" ? current : "closing");
    return undefined;
  }, [open, reducedMotion]);

  useEffect(() => {
    if (!open) {
      setExpanded(false);
      setFilter("all");
      setCollapsedGroups(new Set());
    }
  }, [open]);

  const requestClose = useCallback(() => {
    onOpenChange(false);
    returnFocusRef.current?.focus();
  }, [onOpenChange, returnFocusRef]);

  // Esc 关闭 + 浮层外点击关闭（铃铛按钮自洽：click 在按钮上，由其 toggle 处理）。
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".sh-notification-popover, .sh-notification-bell")) return;
      requestClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, requestClose]);

  // Mount in the entering state in the same render that opens the panel so the
  // CSS keyframe starts on the element's first rendered frame.
  const visiblePhase = phase === "closed" && open
    ? reducedMotion ? "open" : "entering"
    : phase;
  if (visiblePhase === "closed") return null;

  // 历史项激活（点击消息本体或 action 链接）：先把该条标记为已读，再收起
  // 浮层或交给 Link 默认导航；markRead 幂等，重复激活不报错。
  const readAndClose = (id: string) => {
    markRead(id);
    requestClose();
  };

  const filterVisible = filter === "unread" ? notices.filter((notice) => !notice.read) : notices;
  const grouped = new Map<NoticeSource, AppNoticeRecord[]>();
  for (const notice of filterVisible) {
    const key = notice.source ?? "system";
    grouped.set(key, [...(grouped.get(key) ?? []), notice]);
  }
  const stackEdges = Math.min(notices.length - 1, 2);
  const latest = notices[0];
  const language = i18n.resolvedLanguage ?? i18n.language ?? "en";

  const renderCard = (notice: AppNoticeRecord) => (
    <li className="sh-notification-popover__item" key={notice.id}>
      {/* 消息本体是可聚焦按钮（点击/回车先标已读再收起浮层）；action 链接
          是交互元素不能嵌进按钮，保持为兄弟节点；detailNode 含流内容，同样
          留在按钮外。 */}
      <button
        aria-label={t("notifications.markOneRead", { title: notice.title })}
        className={[
          "sh-notification-popover__card",
          notice.read ? "" : "sh-notification-popover__card--unread",
        ].filter(Boolean).join(" ")}
        onClick={() => readAndClose(notice.id)}
        type="button"
      >
        <span className="sh-notification-popover__card-head">
          <span className={`sh-notification-popover__dot sh-notification-popover__dot--${notice.tone}`} aria-hidden="true" />
          <NoticeSourceBadge source={notice.source ?? "system"} />
          <span className="sh-notification-popover__title">{notice.title}</span>
          <time className="sh-notification-popover__time" dateTime={new Date(notice.createdAt).toISOString()}>
            {formatNoticeTime(notice.createdAt, language)}
          </time>
        </span>
        {notice.detail ? (
          <span className="sh-notification-popover__detail">{notice.detail}</span>
        ) : null}
      </button>
      {notice.detailNode}
      {notice.action ? (
        <Link
          className="sh-notification-popover__action"
          onClick={() => readAndClose(notice.id)}
          to={notice.action.to}
        >
          {notice.action.label}
        </Link>
      ) : null}
    </li>
  );

  return createPortal(
    <div
      aria-label={t("notifications.drawerTitle")}
      className="sh-notification-popover"
      data-reduced-motion={String(reducedMotion)}
      data-state={visiblePhase}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.animationName === "sh-notification-popover-enter" && visiblePhase === "entering") {
          setPhase("open");
        } else if (event.animationName === "sh-notification-popover-exit" && visiblePhase === "closing") {
          setPhase("closed");
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") requestClose();
      }}
      role="dialog"
    >
      <header className="sh-notification-popover__header">
        <h2 className="sh-notification-popover__heading">{t("notifications.drawerTitle")}</h2>
        {unreadCount > 0 ? (
          <span className="sh-notification-popover__count">
            {t("notifications.buttonWithUnread", { count: unreadCount })}
          </span>
        ) : null}
        <IconButton
          aria-label={t("actions.close")}
          className="sh-notification-popover__close"
          icon="close"
          label={t("actions.close")}
          onClick={requestClose}
        />
      </header>

      {notices.length === 0 ? (
        <p className="sh-notification-popover__empty" role="status">
          {t("notifications.emptyHistory")}
        </p>
      ) : !expanded ? (
        <>
          {/* 折叠态：最新一条完整展示，其下至多两条只露出卡片上缘（层叠）。 */}
          <ul className="sh-notification-popover__stack">
            {latest ? (
              <li className="sh-notification-popover__item">
                <button
                  aria-label={notices.length > 1
                    ? t("notifications.expandStack", { count: notices.length })
                    : t("notifications.markOneRead", { title: latest.title })}
                  aria-expanded={notices.length > 1 ? false : undefined}
                  className={[
                    "sh-notification-popover__card",
                    latest.read ? "" : "sh-notification-popover__card--unread",
                  ].filter(Boolean).join(" ")}
                  onClick={() => notices.length > 1 ? setExpanded(true) : readAndClose(latest.id)}
                  type="button"
                >
                  <span className="sh-notification-popover__card-head">
                    <span className={`sh-notification-popover__dot sh-notification-popover__dot--${latest.tone}`} aria-hidden="true" />
                    <NoticeSourceBadge source={latest.source ?? "system"} />
                    <span className="sh-notification-popover__title">{latest.title}</span>
                    <time className="sh-notification-popover__time" dateTime={new Date(latest.createdAt).toISOString()}>
                      {formatNoticeTime(latest.createdAt, language)}
                    </time>
                  </span>
                  {latest.detail ? (
                    <span className="sh-notification-popover__detail">{latest.detail}</span>
                  ) : null}
                </button>
                {latest.detailNode}
                {latest.action ? (
                  <Link
                    className="sh-notification-popover__action"
                    onClick={() => readAndClose(latest.id)}
                    to={latest.action.to}
                  >
                    {latest.action.label}
                  </Link>
                ) : null}
              </li>
            ) : null}
            {Array.from({ length: stackEdges }, (_, index) => (
              <li
                aria-hidden="true"
                className="sh-notification-popover__edge"
                data-testid="notification-stack-edge"
                data-layer={index + 1}
                key={`stack-edge-${index}`}
              />
            ))}
          </ul>
          <footer className="sh-notification-popover__footer">
            <Button onClick={markAllRead} size="sm" variant="ghost">
              {t("notifications.markAllRead")}
            </Button>
            <Button disabled={notices.length === 0} onClick={clear} size="sm" variant="ghost">
              {t("notifications.clearAll")}
            </Button>
            <Button aria-expanded="true" onClick={() => setExpanded(true)} size="sm" variant="secondary">
              {t("notifications.viewAll")}
            </Button>
          </footer>
        </>
      ) : (
        <>
          <div className="sh-notification-popover__controls">
            <div
              aria-label={t("notifications.drawerTitle")}
              className="sh-notification-popover__filter"
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
          {filterVisible.length === 0 ? (
            <p className="sh-notification-popover__empty" role="status">
              {notices.length === 0 ? t("notifications.emptyHistory") : t("notifications.emptyUnread")}
            </p>
          ) : (
            <div className="sh-notification-popover__groups">
              {[...grouped].map(([source, groupNotices]) => {
                const collapsed = collapsedGroups.has(source);
                return (
                  <section className="sh-notification-popover__group" key={source}>
                    <h3 className="sh-notification-popover__group-head">
                      <button
                        aria-expanded={!collapsed}
                        className="sh-notification-popover__group-toggle"
                        onClick={() => setCollapsedGroups((current) => {
                          const next = new Set(current);
                          if (next.has(source)) {
                            next.delete(source);
                          } else {
                            next.add(source);
                          }
                          return next;
                        })}
                        type="button"
                      >
                        <span>{t(`notifications.sources.${source}`)}</span>
                        <span aria-hidden="true" className="sh-notification-popover__group-count">{groupNotices.length}</span>
                      </button>
                    </h3>
                    {!collapsed ? (
                      <ul className="sh-notification-popover__list">{groupNotices.map(renderCard)}</ul>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
          <footer className="sh-notification-popover__footer">
            <Button aria-expanded="true" onClick={() => setExpanded(false)} size="sm" variant="secondary">
              {t("notifications.collapse")}
            </Button>
          </footer>
        </>
      )}
    </div>,
    document.body,
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
  if (useInRouterContext()) {
    return <RoutedToastRegion notices={notices} onDismiss={onDismiss} toast={toast} />;
  }
  return (
    <ToastRegionContent
      notices={notices}
      onDismiss={onDismiss}
      toast={toast}
    />
  );
}

function RoutedToastRegion({
  notices,
  onDismiss,
  toast,
}: {
  toast: ToastState;
  notices: ReadonlyArray<AppNoticeRecord>;
  onDismiss: (id: string) => void;
}) {
  return (
    <ToastRegionContent
      notices={notices}
      onDismiss={onDismiss}
      toast={toast}
    />
  );
}

function ToastRegionContent({
  notices,
  onDismiss,
  toast,
}: {
  toast: ToastState;
  notices: ReadonlyArray<AppNoticeRecord>;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  const reducedMotion = useSkillHubReducedMotion();
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
