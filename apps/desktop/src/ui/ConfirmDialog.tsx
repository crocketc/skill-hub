import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { ReactElement } from "react";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  cancelLabel: string;
  confirmLabel: string;
  description: string;
  onConfirm: () => void;
  title: string;
  trigger: ReactElement;
  variant?: "primary" | "danger";
}

export function ConfirmDialog({
  cancelLabel,
  confirmLabel,
  description,
  onConfirm,
  title,
  trigger,
  variant = "danger",
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="sh-overlay" />
        <AlertDialog.Content className="sh-dialog">
          <AlertDialog.Title className="sh-dialog__title">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="sh-dialog__description">
            {description}
          </AlertDialog.Description>
          <div className="sh-dialog__actions">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button onClick={onConfirm} variant={variant}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
