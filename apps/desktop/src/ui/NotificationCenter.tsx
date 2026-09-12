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
import "./notificationCenter.css";

/**
 * P1-11 全局通知规范：
 * - 成功/中性通知 `role="status"` + `aria-live="polite"`，自动消退（时长常量
 *   NOTICE_AUTO_DISMISS_MS，Promise/timeout 驱动，非“任意延时”）且可手动关闭；
 * - 危险/失败通知 `role="alert"`，常驻不自动消失，必须显式关闭；
 * - 批量删除等危险操作的结果一律 persistent，即使全部成功也保持常驻。
 * 通知容器 fixed 定位；库页等有批量操作条的场景经 CSS 变量
 * `--skill-batch-bar-height` 抬升底部避让（该变量经 DOM 继承可得）。
 */

export type NoticeTone = "success" | "info" | "danger";

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
  id: number;
  kind?: string;
  message: string;
  persistent: boolean;
  tone: NoticeTone;
}

export const NOTICE_AUTO_DISMISS_MS = 6000;

export function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismissNotice = useCallback((id: number) => {
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
          const timer = timersRef.current.get(notice.id);
          if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(notice.id);
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

export function NotificationCenter({
  notices,
  onDismiss,
}: {
  notices: Notice[];
  onDismiss: (id: number) => void;
}): JSX.Element | null {
  const { t } = useTranslation();
  // 键盘用户 Tab 进入通知关闭按钮后关闭通知，按钮随之卸载：
  // 把焦点送回进入通知前的宿主，避免丢焦到 body（对齐 Drawer 回退模式）。
  const focusHostRef = useRef<HTMLElement | null>(null);
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
