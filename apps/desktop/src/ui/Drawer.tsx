import * as Dialog from "@radix-ui/react-dialog";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { Button } from "./Button";

export interface DrawerProps {
  children: ReactNode;
  closeLabel?: string;
  description?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
  trigger?: ReactElement;
}

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
  closeLabel = "Close",
  description,
  onOpenChange,
  open,
  title,
  trigger,
}: DrawerProps) {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="sh-overlay" />
        <Dialog.Content
          className="sh-drawer"
          data-reduced-motion={String(reducedMotion)}
          data-testid="drawer-panel"
        >
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
              <Button aria-label={closeLabel} size="sm" variant="ghost">
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
