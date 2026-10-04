import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";

interface ConflictSaveDialogProps {
  busy: boolean;
  onReload: () => void;
  onSaveCopy: () => void;
  open: boolean;
}

/**
 * K4 故障矩阵：保存时内容身份冲突（文件在 SkillHub 之外被修改）。
 *
 * 不允许静默覆盖：本机草稿保留，用户在「重新加载最新文件（放弃本地修改，
 * 换取服务端最新内容）」与「另存为副本（推荐，本地内容零丢失）」之间显式
 * 选择。Escape / 点击遮罩不关闭——两个出口都必须是显式决定。保存命令本身
 * 不变（save_markdown_content / save_markdown_as_copy）。
 */
export function ConflictSaveDialog({
  busy,
  onReload,
  onSaveCopy,
  open,
}: ConflictSaveDialogProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog.Root
      // 受控且不可轻 dismiss：open 只由两个显式动作收口。
      onOpenChange={() => undefined}
      open={open}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="sh-overlay" />
        <AlertDialog.Content
          className="sh-dialog"
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <AlertDialog.Title className="sh-dialog__title">
            {t("markdown.editor.conflictTitle")}
          </AlertDialog.Title>
          <AlertDialog.Description className="sh-dialog__description">
            {t("markdown.editor.conflictDescription")}
          </AlertDialog.Description>
          <div className="sh-dialog__actions">
            <AlertDialog.Action asChild>
              <Button disabled={busy} onClick={onReload} variant="secondary">
                {t("markdown.editor.conflictReload")}
              </Button>
            </AlertDialog.Action>
            <AlertDialog.Action asChild>
              <Button disabled={busy} onClick={onSaveCopy}>
                {t("markdown.editor.conflictSaveCopy")}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
