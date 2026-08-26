import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useEffect, useId, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { CodeBlock } from "./CodeBlock";
import { renderMermaidSvg } from "./mermaidRuntime";
import { classifyMarkdownUrl } from "./sanitize";

interface MermaidBlockProps {
  code: string;
  onExternalTarget: (target: string) => void;
}

export function MermaidBlock({ code, onExternalTarget }: MermaidBlockProps) {
  const { t } = useTranslation();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [view, setView] = useState<"diagram" | "source">("diagram");
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [externalTarget, setExternalTarget] = useState<string>();

  useEffect(() => {
    if (view !== "diagram" || svg || failed) {
      return;
    }
    let active = true;
    void renderMermaidSvg(code, `skillhub-mermaid-${id}`)
      .then((result) => {
        if (active) {
          setSvg(result);
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          setView("source");
        }
      });
    return () => {
      active = false;
    };
  }, [code, failed, id, svg, view]);

  const inspectSvgTarget = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) {
      return;
    }
    event.preventDefault();
    const target = classifyMarkdownUrl(href);
    if (target.kind === "external") {
      setExternalTarget(target.target);
    }
  };

  return (
    <figure className="sh-mermaid-block">
      <div aria-label={t("markdown.mermaid.views")} role="tablist">
        <Button
          aria-selected={view === "diagram"}
          onClick={() => setView("diagram")}
          role="tab"
          size="sm"
          variant={view === "diagram" ? "secondary" : "ghost"}
        >
          {t("markdown.mermaid.diagram")}
        </Button>
        <Button
          aria-selected={view === "source"}
          onClick={() => setView("source")}
          role="tab"
          size="sm"
          variant={view === "source" ? "secondary" : "ghost"}
        >
          {t("markdown.mermaid.source")}
        </Button>
      </div>
      {failed ? <p role="alert">{t("markdown.mermaid.unavailable")}</p> : null}
      {view === "source" ? (
        <CodeBlock code={code} language="mermaid" />
      ) : svg ? (
        <div
          className="sh-mermaid-block__diagram"
          onClick={inspectSvgTarget}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p role="status">{t("markdown.mermaid.loading")}</p>
      )}
      <AlertDialog.Root
        onOpenChange={(open) => {
          if (!open) {
            setExternalTarget(undefined);
          }
        }}
        open={Boolean(externalTarget)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="sh-overlay" />
          <AlertDialog.Content className="sh-dialog">
            <AlertDialog.Title className="sh-dialog__title">
              {t("markdown.external.title")}
            </AlertDialog.Title>
            <AlertDialog.Description className="sh-dialog__description">
              {externalTarget}
            </AlertDialog.Description>
            <div className="sh-dialog__actions">
              <AlertDialog.Cancel asChild>
                <Button variant="secondary">{t("actions.cancel")}</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  onClick={() => {
                    if (externalTarget) {
                      onExternalTarget(externalTarget);
                    }
                  }}
                >
                  {t("markdown.external.open")}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </figure>
  );
}
