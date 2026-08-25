import * as Dialog from "@radix-ui/react-dialog";
import {
  type CSSProperties,
  type RefObject,
  type ReactElement,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";

interface DrawerBaseProps {
  children: ReactNode;
  closeLabel?: string;
  description?: string;
  leadingAccessory?: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  panelClassName?: string;
  panelStyle?: CSSProperties;
  title: string;
}

type DrawerFocusTarget =
  | {
      returnFocusRef?: RefObject<HTMLElement | null>;
      trigger: ReactElement;
    }
  | {
      returnFocusRef: RefObject<HTMLElement | null>;
      trigger?: never;
    };

export type DrawerProps = DrawerBaseProps & DrawerFocusTarget;

function getReducedMotionPreference() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(getReducedMotionPreference);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return undefined;
    }

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reduced;
}

export function Drawer({
  children,
  closeLabel,
  description,
  leadingAccessory,
  onOpenChange,
  open,
  panelClassName,
  panelStyle,
  returnFocusRef,
  title,
  trigger,
}: DrawerProps) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const resolvedCloseLabel = closeLabel ?? t("actions.close");

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="sh-overlay" />
        <Dialog.Content
          className={["sh-drawer", panelClassName].filter(Boolean).join(" ")}
          data-reduced-motion={String(reducedMotion)}
          data-testid="drawer-panel"
          onCloseAutoFocus={(event) => {
            if (returnFocusRef?.current) {
              event.preventDefault();
              returnFocusRef.current.focus();
            }
          }}
          style={panelStyle}
        >
          {leadingAccessory}
          <header className="sh-drawer__header">
            <div>
              <Dialog.Title className="sh-drawer__title">{title}</Dialog.Title>
              <Dialog.Description
                className={
                  description ? "sh-drawer__description" : "sh-visually-hidden"
                }
              >
                {description ?? title}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button aria-label={resolvedCloseLabel} size="sm" variant="ghost">
                <span aria-hidden="true">×</span>
              </Button>
            </Dialog.Close>
          </header>
          <div className="sh-drawer__body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
