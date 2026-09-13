import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

interface ExternalLinkProps {
  children: ReactNode;
  onOpen: () => void;
  target: string;
  /** 可访问名；缺省回退到触发按钮的可见内容。 */
  ariaLabel?: string;
}

export function ExternalLink({ children, onOpen, target, ariaLabel }: ExternalLinkProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      cancelLabel={t("actions.cancel")}
      confirmLabel={t("markdown.external.open")}
      description={target}
      onConfirm={onOpen}
      title={t("markdown.external.title")}
      trigger={
        <button aria-label={ariaLabel} className="sh-markdown-link" role="link" type="button">
          {children}
        </button>
      }
      variant="primary"
    />
  );
}
