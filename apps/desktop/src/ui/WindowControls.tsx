import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  resolveWindowChrome,
  type WindowChrome,
} from "../platform/windowChrome";
import "./WindowControls.css";

/**
 * 自绘窗口控制按钮（一体化标题栏的 Windows 形态；macOS 用系统红绿灯）。
 * 非 Tauri 环境（浏览器/e2e/单测）resolveWindowChrome() 返回 null，
 * 本组件渲染 null，完全无痕。
 */

function MinimizeIcon() {
  return (
    <svg
      className="sh-window-controls__icon"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
    >
      {/* Win11 caption 风格：水平细线 */}
      <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg
      className="sh-window-controls__icon"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
    >
      {/* 方框 */}
      <rect
        x="0.5"
        y="0.5"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg
      className="sh-window-controls__icon"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
    >
      {/* 错叠双方框：后框右上、前框左下 */}
      <path
        d="M3.5 0.5h6v6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <rect
        x="0.5"
        y="3.5"
        width="6"
        height="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      className="sh-window-controls__icon"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
    >
      {/* 斜十字 */}
      <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function WindowControls() {
  const { t } = useTranslation();
  // 平台能力只在挂载时解析一次，避免重渲染反复触碰 Tauri API。
  const [chrome] = useState<WindowChrome | null>(() => resolveWindowChrome());
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!chrome) {
      return;
    }
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const initial = await chrome.isMaximized();
      if (!active) {
        return;
      }
      setMaximized(initial);
      const stop = await chrome.onMaximizeChange((next) => {
        if (active) {
          setMaximized(next);
        }
      });
      if (!active) {
        // 卸载晚于订阅建立：立即退订，不泄漏监听。
        stop();
        return;
      }
      unlisten = stop;
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [chrome]);

  if (!chrome) {
    return null;
  }

  return (
    <div className="sh-window-controls">
      <button
        type="button"
        className="sh-window-controls__button"
        aria-label={t("appShell.minimize")}
        onClick={() => {
          void chrome.minimize();
        }}
      >
        <MinimizeIcon />
      </button>
      <button
        type="button"
        className="sh-window-controls__button"
        aria-label={maximized ? t("appShell.restore") : t("appShell.maximize")}
        onClick={() => {
          void chrome.toggleMaximize();
        }}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className="sh-window-controls__button sh-window-controls__button--close"
        aria-label={t("appShell.close")}
        onClick={() => {
          void chrome.close();
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
