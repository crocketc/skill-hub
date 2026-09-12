import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useState, type FormEvent, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";

export type BatchTagAction = "add_tag" | "remove_tag";

interface BatchTagDialogProps {
  action: BatchTagAction;
  count: number;
  onCancel: () => void;
  onConfirm: (tags: string[]) => void;
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

export function BatchTagDialog({ action, count, onCancel, onConfirm }: BatchTagDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  // P1-15：移除标签是独立的移除对象——提交前先展示轻量预览
  //（将移除的标签名 + 受影响 Skill 数），确认后才写回元数据。
  const [previewingRemoval, setPreviewingRemoval] = useState(false);
  const tags = useMemo(() => parseTags(value), [value]);
  const isAdd = action === "add_tag";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (tags.length === 0) return;
    if (isAdd) onConfirm(tags);
    else setPreviewingRemoval(true);
  };

  const titleKey = previewingRemoval
    ? "skillLibrary.page.batch.removeTagsConfirmTitle"
    : isAdd
      ? "skillLibrary.page.batch.addTagsTitle"
      : "skillLibrary.page.batch.removeTagsTitle";
  const descriptionKey = previewingRemoval
    ? "skillLibrary.page.batch.removeTagsConfirmDescription"
    : isAdd
      ? "skillLibrary.page.batch.addTagsDescription"
      : "skillLibrary.page.batch.removeTagsDescription";

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="sh-overlay" />
        <Dialog.Content aria-describedby="batch-tag-dialog-description" className="sh-dialog sh-batch-tag-dialog" aria-label={t(titleKey)}>
          <Dialog.Title className="sh-dialog__title">
            {t(titleKey)}
          </Dialog.Title>
          <Dialog.Description className="sh-dialog__description" id="batch-tag-dialog-description">
            {t(descriptionKey)}
          </Dialog.Description>
          {previewingRemoval ? (
            <div>
              <ul className="sh-batch-tag-dialog__tags">
                {tags.map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
              <p className="sh-batch-tag-dialog__impact" role="status">
                {t("skillLibrary.page.batch.impact", { count })}
              </p>
              <div className="sh-batch-tag-dialog__disclaimer">
                <p>{t("skillLibrary.page.batch.removeTagsRetained")}</p>
                <p>{t("skillLibrary.page.batch.removeTagsRecovery")}</p>
              </div>
              <div className="sh-dialog__actions">
                <Button onClick={() => setPreviewingRemoval(false)} type="button" variant="secondary">
                  {t("actions.back")}
                </Button>
                <Button onClick={() => onConfirm(tags)} type="button">
                  {t("skillLibrary.page.batch.removeTagsConfirmAction")}
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit}>
              <label className="sh-batch-tag-dialog__field">
                {t("skillLibrary.page.batch.tagsLabel")}
                <input
                  autoFocus
                  aria-describedby="batch-tag-dialog-hint"
                  aria-label={t("skillLibrary.page.batch.tagsLabel")}
                  onChange={(event) => setValue(event.currentTarget.value)}
                  placeholder={t("skillLibrary.page.batch.tagsPlaceholder")}
                  type="text"
                  value={value}
                />
                <span id="batch-tag-dialog-hint">{t("skillLibrary.page.batch.tagsHint")}</span>
              </label>
              <p className="sh-batch-tag-dialog__impact" role="status">
                {t("skillLibrary.page.batch.impact", { count })}
              </p>
              <div className="sh-dialog__actions">
                <Button onClick={onCancel} type="button" variant="secondary">
                  {t("actions.cancel")}
                </Button>
                <Button disabled={tags.length === 0} type="submit">
                  {t(isAdd ? "skillLibrary.page.batch.addTags" : "skillLibrary.page.batch.removeTags")}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
