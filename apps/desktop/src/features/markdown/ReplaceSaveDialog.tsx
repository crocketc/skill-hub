import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";

interface ReplaceSaveDialogProps {
  busy: boolean;
  onConfirmReplace: () => void;
  onOpenChange: (open: boolean) => void;
  onSaveCopy: () => void;
  open: boolean;
  path: string;
}

/**
 * 受控"保存并替换原 Skill"确认面板（P1-14）。
 *
 * 替换保存的命令与语义早已存在（save_markdown_content，每次生成新版本）；
 * 本面板补的是受控边界：明确覆盖风险、指出版本时间线的可恢复路径，
 * 并把"另存副本"作为推荐主操作。不改变任何保存命令语义。
 */
export function ReplaceSaveDialog({
  busy,
  onConfirmReplace,
  onOpenChange,
  onSaveCopy,
  open,
  path,
}: ReplaceSaveDialogProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog.Root onOpenChange={onOpenChange} open={open}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="sh-overlay" />
        <AlertDialog.Content className="sh-dialog">
          <AlertDialog.Title className="sh-dialog__title">
            {t("markdown.editor.replaceConfirmTitle")}
          </AlertDialog.Title>
          <AlertDialog.Description className="sh-dialog__description">
            {t("markdown.editor.replaceConfirmLead", { path })}
          </AlertDialog.Description>
          <ul className="sh-markdown-editor__replace-notes">
            <li>{t("markdown.editor.replaceConfirmRecoverNote")}</li>
            <li>{t("markdown.editor.replaceConfirmCopyNote")}</li>
          </ul>
          <div className="sh-dialog__actions">
            <AlertDialog.Cancel asChild>
              <Button disabled={busy} variant="ghost">
                {t("actions.cancel")}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button disabled={busy} onClick={onConfirmReplace} variant="secondary">
                {t("markdown.editor.replaceConfirmReplaceAction")}
              </Button>
            </AlertDialog.Action>
            <AlertDialog.Action asChild>
              <Button disabled={busy} onClick={onSaveCopy}>
                {t("markdown.editor.replaceConfirmCopyAction")}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
