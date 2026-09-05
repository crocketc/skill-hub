import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { SourceDescriptor } from "./api";

export interface SourceInputProps {
  value: string;
  actionLabel?: string;
  descriptor?: SourceDescriptor;
  disabled?: boolean;
  suggestedSources?: string[];
  selectedSources?: string[];
  onChange: (value: string) => void;
  onParse: () => void;
  onPickLocalPath?: () => void;
  onToggleSource?: (source: string) => void;
  onSelectAllSources?: () => void;
}

export function SourceInput({
  value,
  actionLabel,
  descriptor,
  disabled = false,
  suggestedSources = [],
  selectedSources = [],
  onChange,
  onParse,
  onPickLocalPath,
  onToggleSource,
  onSelectAllSources,
}: SourceInputProps) {
  const { t } = useTranslation();
  const isNpxReference = /^npx\s+skills\s+add\s+/i.test(value.trim());

  return (
    <section className="sh-import-source" aria-labelledby="import-source-title">
      <div className="sh-import-source__heading">
        <div>
          <p className="sh-import-source__eyebrow">{t("importWorkflow.source.eyebrow")}</p>
          <h2 id="import-source-title">{t("importWorkflow.source.title")}</h2>
          <p>{t("importWorkflow.source.description")}</p>
        </div>
        <span className="sh-import-source__step">{t("importWorkflow.step", { current: 1, total: 4 })}</span>
      </div>

      {suggestedSources.length > 0 ? (
        <fieldset className="sh-import-source__suggestions">
          <legend>{t("importWorkflow.source.scannedSources")}</legend>
          <p>{t("importWorkflow.source.scannedSourcesDescription")}</p>
          {onSelectAllSources ? (
            <Button disabled={disabled} onClick={onSelectAllSources} variant="secondary">
              {t("importWorkflow.source.selectAllSources")}
            </Button>
          ) : null}
          {suggestedSources.map((source) => (
            <label key={source}>
              <input
                checked={selectedSources.includes(source)}
                disabled={disabled}
                onChange={() => onToggleSource?.(source)}
                type="checkbox"
              />
              <code>{source}</code>
            </label>
          ))}
        </fieldset>
      ) : null}

      {onPickLocalPath ? (
        <div className="sh-import-source__picker">
          <Button disabled={disabled} onClick={onPickLocalPath} variant="secondary">
            {t("importWorkflow.source.pickLocalDirectory")}
          </Button>
          <span>{t("importWorkflow.source.manualFallback")}</span>
        </div>
      ) : null}

      <label className="sh-import-source__field">
        <span>{t("importWorkflow.source.label")}</span>
        <textarea
          aria-label={t("importWorkflow.source.label")}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={t("importWorkflow.source.placeholder")}
          rows={3}
          value={value}
        />
      </label>

      {isNpxReference ? (
        <p className="sh-import-source__notice" role="status">
          {t("importWorkflow.source.npxParseOnly")}
        </p>
      ) : null}

      {descriptor ? (
        <dl className="sh-import-source__descriptor" aria-label={t("importWorkflow.source.detectedSource")}>
          <div>
            <dt>{t("importWorkflow.source.type")}</dt>
            <dd>{t(`importWorkflow.source.kinds.${descriptor.kind}`)}</dd>
          </div>
          <div>
            <dt>{t("importWorkflow.source.target")}</dt>
            <dd>{descriptor.displayTarget}</dd>
          </div>
        </dl>
      ) : null}

      <div className="sh-import-source__actions">
        <Button disabled={disabled || (!value.trim() && selectedSources.length === 0)} onClick={onParse}>
          {actionLabel ?? t("importWorkflow.source.parse")}
        </Button>
      </div>
    </section>
  );
}
