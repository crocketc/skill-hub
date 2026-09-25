import { useTranslation } from "react-i18next";
import type { GovernanceHistoryEntry } from "../../../api/bindings";
import { Button } from "../../../ui/Button";
import { displayPath } from "../../../platform/displayPath";
import { AgentIdentity } from "../../skills/AgentDeploymentIcons";

/**
 * 动作/结果的展示映射：已知词表走 i18n，未知值原样展示（诚实降级），
 * 绝不把未知动作翻译成接近的已知词。
 */
const KNOWN_ACTIONS = new Set([
  "clean_source_copy",
  "retain_source_copy",
  "relink_source_copy",
  "centralize_management",
  "retain",
  "relink",
  "validate",
]);

const KNOWN_RESULTS = new Set([
  "committed",
  "retained",
  "relinked",
  "archived",
  "rolled_back",
  "failed",
]);

/** 动作展示键；已知词表走 i18n，未知值由调用方原样展示（诚实降级）。 */
export function governanceHistoryActionLabelKey(action: string): string | null {
  return KNOWN_ACTIONS.has(action)
    ? `relationships.governance.history.action.${action}`
    : null;
}

/** 结果展示键；语义同上。 */
export function governanceHistoryResultLabelKey(result: string): string | null {
  return KNOWN_RESULTS.has(result)
    ? `relationships.governance.history.result.${result}`
    : null;
}

/** occurred_at 是写盘时固化的 epoch 毫秒（跨 IPC 以字符串承载）。 */
export function formatGovernanceHistoryTime(occurredAt: string): string {
  const date = new Date(Number(occurredAt));
  if (Number.isNaN(date.getTime())) return occurredAt;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function formatTime(occurredAt: string): string {
  return formatGovernanceHistoryTime(occurredAt);
}

export function GovernanceHistoryTable({
  entries,
  onRelink,
}: {
  entries: readonly GovernanceHistoryEntry[];
  onRelink: (entry: GovernanceHistoryEntry) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="sh-governance__history-scroll">
      <table className="sh-governance__history">
        <thead>
          <tr>
            <th scope="col">{t("relationships.governance.history.time")}</th>
            <th scope="col">{t("relationships.governance.history.object")}</th>
            <th scope="col">{t("relationships.governance.history.scopeColumn")}</th>
            <th scope="col">{t("relationships.governance.history.actionColumn")}</th>
            <th scope="col">{t("relationships.governance.history.resultColumn")}</th>
            <th scope="col">{t("agents.pathLabel")}</th>
            <th scope="col">{t("relationships.governance.history.followUp")}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const externalRemoved = entry.result === "archived" && entry.reason === "external_removed";
            const failed = entry.result === "failed";
            return (
              <tr data-relation-id={entry.relation_id} data-testid={`governance-history-row-${entry.relation_id}`} key={`${entry.relation_id}-${entry.occurred_at}`}>
                <td>{formatTime(entry.occurred_at)}</td>
                <td>
                  <strong>{entry.skill_display_name}</strong>
                  {entry.agent.client_id ? <AgentIdentity agentId={entry.agent.client_id} /> : null}
                </td>
                <td>
                  {t(`relationships.governance.history.scope.${entry.scope}` as never, {
                    defaultValue: entry.scope,
                  })}
                </td>
                <td data-testid={`governance-history-action-${entry.relation_id}`}>
                  {(() => {
                    const key = governanceHistoryActionLabelKey(entry.action);
                    return key ? t(key as never) : entry.action;
                  })()}
                </td>
                <td data-testid={`governance-history-result-${entry.relation_id}`}>
                  {externalRemoved ? (
                    // 诚实呈现：外部删除导致的归档不是 SkillHub 的清理行为。
                    <span>{t("relationships.governance.history.externalRemoved")}</span>
                  ) : (
                    <span>
                      {(() => {
                        const key = governanceHistoryResultLabelKey(entry.result);
                        return key ? t(key as never) : entry.result;
                      })()}
                    </span>
                  )}
                  {failed && entry.reason ? <span>{entry.reason}</span> : null}
                </td>
                <td>
                  <code>{displayPath(entry.path)}</code>
                </td>
                <td>
                  {externalRemoved ? (
                    <Button
                      data-testid={`governance-history-relink-${entry.relation_id}`}
                      onClick={() => onRelink(entry)}
                      size="sm"
                      variant="secondary"
                    >
                      {t("relationships.governance.history.relink")}
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
