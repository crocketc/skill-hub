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
  /** M-29：失败来源在统一确认列表内重试。 */
  onRetrySource?: (source: string) => void;
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
  onRetrySource,
}: SourceInputProps) {
  const { t } = useTranslation();
  const isNpxReference = /^npx\s+skills\s+add\s+/i.test(value.trim());
  // M-29：多选删除的勾选标记是纯列表 UI 状态；删除后立即清空。
  const [markedSources, setMarkedSources] = useState<string[]>([]);
  const marked = markedSources.filter((source) => selectedSources.includes(source));
  const sourceEntries = Array.from(new Set([...suggestedSources, ...selectedSources]));
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
      case "scanning":
        return t("importWorkflow.sources.status.scanning");
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

      {sourceEntries.length > 0 ? (
        <fieldset className="sh-import-source__selected">
          <legend>{t("importWorkflow.sources.confirmation")}</legend>
          <p>{t("importWorkflow.sources.description")}</p>
          {onSelectAllSources && suggestedSources.length > 0 ? (
            <Button disabled={disabled} onClick={onSelectAllSources} variant="secondary">
              {t(selectedSources.length > 0 && suggestedSources.every((source) => selectedSources.includes(source))
                ? "importWorkflow.source.deselectAllSources"
                : "importWorkflow.source.selectAllSources")}
            </Button>
          ) : null}
          <ul aria-label={t("importWorkflow.sources.heading")} className="sh-import-source__list">
            {sourceEntries.map((source) => {
              const selected = selectedSources.includes(source);
              const status = sourceStatuses[source] ?? { kind: "unscanned" as const };
              return (
                <li
                  className="sh-import-source__item"
                  data-scan-state={selected ? status.kind : "unselected"}
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
                  <label className="sh-import-source__item-select">
                    <input
                      aria-label={source}
                      checked={selected}
                      disabled={disabled}
                      onChange={() => onToggleSource?.(source)}
                      type="checkbox"
                    />
                  </label>
                  <code title={source}>{source}</code>
                  {selected || sourceStatuses[source] ? <StatusBadge tone={statusTone(status)}>{statusLabel(status)}</StatusBadge> : null}
                  {(selected || sourceStatuses[source]) && status.kind === "failed" ? (
                    <span className="sh-import-source__item-reason" role="status">{status.reason}</span>
                  ) : null}
                  {(selected || sourceStatuses[source]) && status.kind === "failed" && onRetrySource ? (
                    <Button
                      aria-label={t("importWorkflow.sources.retrySource", { source })}
                      disabled={disabled}
                      onClick={() => onRetrySource(source)}
                      size="sm"
                      variant="secondary"
                    >
                      {t("importWorkflow.sources.retry")}
                    </Button>
                  ) : null}
                  {selected && onRemoveSource ? (
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
          {onClearSources ? (
            <Button disabled={disabled} onClick={onClearSources} size="sm" variant="ghost">
              {t("importWorkflow.sources.clearAll")}
            </Button>
          ) : null}
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
