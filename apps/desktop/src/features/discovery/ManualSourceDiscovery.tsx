import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { ImportFacade, SourceDescriptor } from "../import/api";

export interface ManualSourceDiscoveryProps {
  facade: Pick<ImportFacade, "parseSource">;
  onOpenLocal: (path: string) => void;
}

export function ManualSourceDiscovery({ facade, onOpenLocal }: ManualSourceDiscoveryProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<SourceDescriptor | null>(null);
  const [error, setError] = useState(false);
  const [parsing, setParsing] = useState(false);

  const parse = async () => {
    const value = input.trim();
    if (!value || parsing) return;
    setParsing(true);
    setStatus(null);
    setError(false);
    try {
      const descriptor = await facade.parseSource(value);
      setStatus(descriptor);
      if (descriptor.kind === "local_path") onOpenLocal(descriptor.displayTarget);
    } catch {
      setError(true);
    } finally {
      setParsing(false);
    }
  };

  return (
    <section aria-label={t("discovery.manual.title")} className="sh-discovery-module sh-manual-source">
      <header className="sh-discovery-module__heading">
        <div>
          <p className="sh-discovery-module__eyebrow">{t("discovery.manual.eyebrow")}</p>
          <h2>{t("discovery.manual.title")}</h2>
        </div>
      </header>
      <p className="sh-discovery-module__description">{t("discovery.manual.description")}</p>
      <div className="sh-discovery-manual-source__controls">
        <label htmlFor="sh-manual-source-input">{t("discovery.manual.inputLabel")}</label>
        <div className="sh-discovery-manual-source__row">
          <input
            id="sh-manual-source-input"
            onChange={(event) => setInput(event.target.value)}
            placeholder={t("discovery.manual.placeholder")}
            type="text"
            value={input}
          />
          <Button disabled={!input.trim() || parsing} onClick={() => void parse()} variant="primary">
            {parsing ? t("discovery.manual.parsing") : t("discovery.manual.parse")}
          </Button>
        </div>
      </div>
      {status ? (
        <div className="sh-discovery-manual-source__result" role="status">
          <strong>
            {status.kind === "local_path"
              ? t("discovery.manual.localKind")
              : t("discovery.manual.recognizedKind")}
          </strong>
          <code title={status.displayTarget}>{status.displayTarget}</code>
          {status.kind === "local_path" ? (
            <p>{t("discovery.manual.localReady")}</p>
          ) : (
            <p>{t("discovery.manual.remoteUnsupported")}</p>
          )}
        </div>
      ) : null}
      {error ? <p role="alert">{t("discovery.manual.parseFailed")}</p> : null}
    </section>
  );
}
