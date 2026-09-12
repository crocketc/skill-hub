import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import type { SourceDescriptor, SourceScanStatus } from "./api";

export interface SourceInputProps {
  value: string;
  descriptor?: SourceDescriptor;
  disabled?: boolean;
  suggestedSources?: string[];
  selectedSources?: string[];
  /** M-29：每个已选目录的扫描状态；缺省视为"未扫描"。 */
  sourceStatuses?: Record<string, SourceScanStatus>;
  /** M-29：要求高亮/聚焦的来源条目（重复添加去重时指向已有项）。 */
  focusedSource?: string;
  onFocusedSourceApplied?: () => void;
  onChange: (value: string) => void;
  /** AR-006：把手动输入追加为第 N 个来源（混合导入），不清空已选来源。 */
  onPickLocalPath?: () => void;
  onToggleSource?: (source: string) => void;
  onSelectAllSources?: () => void;
  /** M-29：已选来源列表的单条删除。 */
  onRemoveSource?: (source: string) => void;
  /** M-29：已选来源列表的多选删除。 */
  onRemoveSources?: (sources: string[]) => void;
  /** M-29：清空全部已选来源。 */
  onClearSources?: () => void;
}

/**
 * 来源表单区：只承载表单语义（扫描来源、目录选择、来源识别、已选来源列表）。
 * 解析/追加来源等流程动作由向导底部的稳定操作区统一提供。
 */
export function SourceInput({
  value,
  descriptor,
  disabled = false,
  suggestedSources = [],
  selectedSources = [],
  sourceStatuses = {},
  focusedSource,
  onFocusedSourceApplied,
  onChange,
  onPickLocalPath,
  onToggleSource,
  onSelectAllSources,
  onRemoveSource,
  onRemoveSources,
  onClearSources,
}: SourceInputProps) {
  const { t } = useTranslation();
  const isNpxReference = /^npx\s+skills\s+add\s+/i.test(value.trim());
  // M-29：多选删除的勾选标记是纯列表 UI 状态；删除后立即清空。
  const [markedSources, setMarkedSources] = useState<string[]>([]);
  const marked = markedSources.filter((source) => selectedSources.includes(source));
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  useEffect(() => {
    if (!focusedSource) return;
    const item = itemRefs.current.get(focusedSource);
    if (item) {
      item.focus();
      onFocusedSourceApplied?.();
    }
  }, [focusedSource, onFocusedSourceApplied]);

  const statusLabel = (status: SourceScanStatus): string => {
    switch (status.kind) {
      case "scanned":
        return t("importWorkflow.sources.status.count", { count: status.count });
      case "failed":
        return t("importWorkflow.sources.status.failed");
      default:
        return t("importWorkflow.sources.status.unscanned");
    }
  };

  const statusTone = (status: SourceScanStatus): "neutral" | "success" | "danger" => {
    switch (status.kind) {
      case "scanned":
        return "success";
      case "failed":
        return "danger";
      default:
        return "neutral";
    }
  };

  const toggleMarked = (source: string) => {
    setMarkedSources((current) =>
      current.includes(source)
        ? current.filter((markedSource) => markedSource !== source)
        : [...current, source],
    );
  };

  const removeMarked = () => {
    if (!onRemoveSources || marked.length === 0) return;
    onRemoveSources(marked);
    setMarkedSources([]);
  };

  return (
    <section className="sh-import-source" aria-labelledby="import-source-title">
      <div className="sh-import-source__heading">
        <div>
          <p className="sh-import-source__eyebrow">{t("importWorkflow.source.eyebrow")}</p>
          <h2 id="import-source-title">{t("importWorkflow.source.title")}</h2>
          <p>{t("importWorkflow.source.description")}</p>
        </div>
      </div>

      {suggestedSources.length > 0 ? (
        <fieldset className="sh-import-source__suggestions">
          <legend>{t("importWorkflow.source.scannedSources")}</legend>
          <p>{t("importWorkflow.source.scannedSourcesDescription")}</p>
          {onSelectAllSources ? (
            <Button disabled={disabled} onClick={onSelectAllSources} variant="secondary">
              {t(selectedSources.length > 0 && suggestedSources.every((source) => selectedSources.includes(source))
                ? "importWorkflow.source.deselectAllSources"
                : "importWorkflow.source.selectAllSources")}
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

      {selectedSources.length > 0 ? (
        <div className="sh-import-source__selected">
          <div className="sh-import-source__selected-heading">
            <h3>{t("importWorkflow.sources.heading")}</h3>
            {onClearSources ? (
              <Button disabled={disabled} onClick={onClearSources} size="sm" variant="ghost">
                {t("importWorkflow.sources.clearAll")}
              </Button>
            ) : null}
          </div>
          <p>{t("importWorkflow.sources.description")}</p>
          <ul aria-label={t("importWorkflow.sources.heading")} className="sh-import-source__list">
            {selectedSources.map((source) => {
              const status = sourceStatuses[source] ?? { kind: "unscanned" as const };
              return (
                <li
                  className="sh-import-source__item"
                  data-scan-state={status.kind}
                  key={source}
                  ref={(node) => {
                    if (node) itemRefs.current.set(source, node);
                    else itemRefs.current.delete(source);
                  }}
                  tabIndex={-1}
                >
                  {onRemoveSources ? (
                    <label className="sh-import-source__item-mark">
                      <input
                        aria-label={t("importWorkflow.sources.markForRemoval", { source })}
                        checked={marked.includes(source)}
                        disabled={disabled}
                        onChange={() => toggleMarked(source)}
                        type="checkbox"
                      />
                    </label>
                  ) : null}
                  <code title={source}>{source}</code>
                  <StatusBadge tone={statusTone(status)}>{statusLabel(status)}</StatusBadge>
                  {status.kind === "failed" ? (
                    <span className="sh-import-source__item-reason" role="status">{status.reason}</span>
                  ) : null}
                  {onRemoveSource ? (
                    <Button
                      aria-label={t("importWorkflow.sources.removeSource", { source })}
                      disabled={disabled}
                      onClick={() => onRemoveSource(source)}
                      size="sm"
                      variant="ghost"
                    >
                      {t("importWorkflow.sources.remove")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {onRemoveSources ? (
            <Button
              disabled={disabled || marked.length === 0}
              onClick={removeMarked}
              size="sm"
              variant="secondary"
            >
              {t("importWorkflow.sources.removeSelected", { count: marked.length })}
            </Button>
          ) : null}
        </div>
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

      {descriptor && descriptor.kind !== "local_path" ? (
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
    </section>
  );
}
