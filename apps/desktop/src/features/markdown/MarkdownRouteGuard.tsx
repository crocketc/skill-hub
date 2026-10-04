import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useBlocker } from "react-router-dom";
import { Button } from "../../ui/Button";
import { draftGuardStore } from "./draftGuardStore";

/**
 * K4-B 离开保护（应用内路由 + 关窗两层）。
 *
 * 必须挂在数据路由（createBrowserRouter）之下：useBlocker 依赖数据路由上下文，
 * 因此本组件不进 MarkdownWorkspace（其单测使用普通 MemoryRouter），而是由
 * router.tsx 在承载工作区的路由上挂载。armed 状态经 draftGuardStore 来自编辑器。
 */
export function MarkdownRouteGuard() {
  const { t } = useTranslation();
  useSyncExternalStore(draftGuardStore.subscribe, draftGuardStore.getVersion);
  const armed = draftGuardStore.armedRegistrations().length > 0;
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const [leaving, setLeaving] = useState(false);

  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    armedRef.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!armed) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chromium 需要 returnValue 才会展示原生关窗确认。
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [armed]);

  const blocked = blocker.state === "blocked";

  const stay = () => {
    blocker.reset?.();
  };

  const leave = () => {
    if (leaving) {
      return;
    }
    setLeaving(true);
    try {
      draftGuardStore.abandonArmed();
      blocker.proceed?.();
    } finally {
      setLeaving(false);
    }
  };

  if (!blocked) {
    return null;
  }

  return (
    <AlertDialog.Root
      onOpenChange={(open) => {
        if (!open) {
          stay();
        }
      }}
      open={blocked}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="sh-overlay" />
        <AlertDialog.Content className="sh-dialog">
          <AlertDialog.Title className="sh-dialog__title">
            {t("markdown.guard.title")}
          </AlertDialog.Title>
          <AlertDialog.Description className="sh-dialog__description">
            {t("markdown.guard.description")}
          </AlertDialog.Description>
          <div className="sh-dialog__actions">
            <AlertDialog.Cancel asChild>
              <Button variant="ghost">{t("markdown.guard.stay")}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button onClick={leave} variant="danger">
                {t("markdown.guard.leave")}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
