import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { ConflictResolutionRecord } from "../../../api/bindings";
import { formatTimestamp, readableTailOfId, resolveLocale } from "../../../i18n";
import { Button } from "../../../ui/Button";
import { DataState } from "../../../ui/DataState";
import {
  useOptionalAppNotifications,
  type AppNotifications,
} from "../../../ui/notifications";
import {
  conflictDecisionLabelKey,
  conflictGovernanceHref,
  conflictKindGroup,
  nextConflictId,
  queueKindValues,
} from "./conflictDecisions";
import { nativeConflictDecisionsFacade, type ConflictDecisionsFacade } from "./decisionsApi";
import { ConflictActions } from "./ConflictActions";
import { ConflictComparison } from "./ConflictComparison";
import "./decisions.css";
import {
  operationTracker,
  type OperationTracker,
} from "../../../platform/operationTracker";
import {
  useConflictAiAnalysis,
  useConflictAiAvailability,
  useConflictWorkspace,
  useResolveConflict,
} from "./useConflictDecisions";

export interface ConflictDecisionPageProps {
  /** 缺省为原生只读投影 + 显式命令门面；测试注入替身。 */
  facade?: ConflictDecisionsFacade;
  /** 统一执行桥的在途投影；测试可注入独立实例。 */
  tracker?: OperationTracker;
  /** 通知中心；缺省取上下文（AppShell 内存在 Provider）。 */
  notifications?: AppNotifications | null;
}

const KIND_CHIP_LABEL_KEYS: Record<string, string> = {
  duplicate_same_content: "relationships.decisions.kind.duplicate_same_content",
  same_name_different_content: "relationships.decisions.kind.same_name_different_content",
  same_source_fork: "relationships.decisions.kind.same_source_fork",
  shared_directory_duplicate: "relationships.decisions.kind.shared_directory_duplicate",
  unknown_directory_recognition: "relationships.decisions.kind.unknown_directory_recognition",
  unknown: "relationships.decisions.kind.unknown",
};

/**
 * 冲突处理工作台（任务 7）：默认队列只含 DTO 给出的待确认 uncertain 冲突
 * （不在前端另行过滤）；类别 chip + 前后导航；已处理项只进历史；
 * AI 可选且从不阻塞人工决定；文件类决定只携带上下文跳治理预览。
 */
export function ConflictDecisionPage({
  facade = nativeConflictDecisionsFacade,
  notifications,
  tracker = operationTracker,
}: ConflictDecisionPageProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const contextNotifications = useOptionalAppNotifications();
  const effectiveNotifications: AppNotifications | null =
    notifications !== undefined ? notifications : contextNotifications;

  const workspaceQuery = useConflictWorkspace(facade);
  const { available: aiAvailable } = useConflictAiAvailability(facade);
  const ai = useConflictAiAnalysis({ facade, tracker });
  const workspace = workspaceQuery.data;
  const cases = workspace?.cases ?? [];
  const handled = workspace?.handled ?? [];

  const categoryParam = searchParams.get("category");
  const conflictIdParam = searchParams.get("conflictId");
  const visibleQueue = categoryParam
    ? cases.filter((entry) => conflictKindGroup(entry) === categoryParam)
    : cases;
  const selectedId =
    conflictIdParam && visibleQueue.some((entry) => entry.case.conflict_id === conflictIdParam)
      ? conflictIdParam
      : visibleQueue[0]?.case.conflict_id ?? null;
  const selectedIndex = visibleQueue.findIndex((entry) => entry.case.conflict_id === selectedId);
  const selectedEntry = selectedIndex >= 0 ? visibleQueue[selectedIndex] : null;

  const patchParams = (patch: { category?: string | null; conflictId?: string | null }) => {
    const params = new URLSearchParams(searchParams);
    if (patch.category === null) params.delete("category");
    else if (patch.category) params.set("category", patch.category);
    if (patch.conflictId === null) params.delete("conflictId");
    else if (patch.conflictId) params.set("conflictId", patch.conflictId);
    setSearchParams(params, { replace: true });
  };

  // 决定完成后该组离开队列：焦点推进到相邻一组（无相邻则清空）。
  const advanceAfterRemove = () => {
    const next =
      nextConflictId(visibleQueue, selectedId, "next")
      ?? nextConflictId(visibleQueue, selectedId, "prev");
    patchParams({ conflictId: next });
  };

  const { resolve, resolving } = useResolveConflict({
    facade,
    notifications: effectiveNotifications,
    onResolved: advanceAfterRemove,
    tracker,
  });

  const selectEntry = (conflictId: string) => patchParams({ conflictId });
  const selectCategory = (kind: string) => {
    const firstOfKind = cases.find((entry) => conflictKindGroup(entry) === kind);
    patchParams({ category: kind, conflictId: firstOfKind?.case.conflict_id ?? null });
  };
  const clearCategory = () => {
    patchParams({ category: null, conflictId: visibleQueue[0]?.case.conflict_id ?? null });
  };
  const step = (direction: "prev" | "next") => {
    const nextId = nextConflictId(visibleQueue, selectedId, direction);
    if (nextId) patchParams({ conflictId: nextId });
  };
  const notNow = () => {
    // 「暂不处理」不是决定：只把焦点移开，不写结论、不写伪历史。
    advanceAfterRemove();
  };
  const centralize = () => {
    // 文件类决定不跨页自动提交：只携带冲突上下文跳治理影响预览。
    navigate(conflictGovernanceHref({ conflictId: selectedId ?? "" }));
  };

  if (workspaceQuery.isPending) {
    return (
      <DataState
        message={t("relationships.decisions.loadPending")}
        state="loading"
      />
    );
  }
  if (workspaceQuery.isError || !workspace) {
    return (
      <DataState
        message={t("relationships.decisions.loadFailed")}
        state="error"
      />
    );
  }

  if (cases.length === 0) {
    return (
      <div className="sh-conflict-page">
        <DataState
          message={
            workspace.handled_count > 0
              ? t("relationships.decisions.empty.allDone", {
                  count: workspace.handled_count,
                })
              : t("relationships.decisions.empty.none")
          }
          hint={t("relationships.decisions.empty.hint")}
          state="empty"
        />
        {handled.length > 0 ? (
          <ConflictHistory handled={handled} />
        ) : null}
      </div>
    );
  }

  const kindChips = queueKindValues(cases);

  return (
    <div className="sh-conflict-page">
      <p className="sh-conflict-page__status">
        <span className="sh-conflict-page__count">
          {t("relationships.decisions.status.pending", { count: cases.length })}
        </span>
        <span className="sh-conflict-page__count">
          {t("relationships.decisions.status.handledTotal", {
            count: workspace.handled_count,
          })}
        </span>
      </p>
      <div className="sh-conflict-page__chips" role="group" aria-label={t("relationships.decisions.chipsLabel")}>
        <Button
          aria-pressed={!categoryParam}
          onClick={clearCategory}
          size="sm"
          variant={!categoryParam ? "secondary" : "ghost"}
        >
          {t("relationships.decisions.chipAll")}
        </Button>
        {kindChips.map((kind) => (
          <Button
            aria-pressed={categoryParam === kind}
            key={kind}
            onClick={() => selectCategory(kind)}
            size="sm"
            variant={categoryParam === kind ? "secondary" : "ghost"}
          >
            {t((KIND_CHIP_LABEL_KEYS[kind] ?? KIND_CHIP_LABEL_KEYS.unknown) as never)}
          </Button>
        ))}
      </div>
      {selectedEntry ? (
        <div className="sh-conflict-workbench">
          <ConflictComparison caseFact={selectedEntry.case} />
          <ConflictActions
            ai={ai}
            aiAvailable={aiAvailable}
            caseEntry={selectedEntry}
            onCentralize={centralize}
            onFollowSuggestion={() => {
              if (selectedEntry.recommended_decision === "confirm_same_skill"
                || selectedEntry.recommended_decision === "keep_distinct") {
                // 失败已由统一执行桥转成 danger 通知后原样 rethrow（任务 7 review
                // minor：void resolve 的 .catch 一致性）——这里标记 promise 已
                // 处理，避免 unhandled rejection，不吞错误、不产生伪成功。
                resolve({
                  caseFact: selectedEntry.case,
                  decision: selectedEntry.recommended_decision,
                  expectedRelationshipRevision: workspace.relationship_revision,
                }).catch(() => undefined);
              }
            }}
            onNotNow={notNow}
            onResolve={(decision) => {
              resolve({
                caseFact: selectedEntry.case,
                decision,
                expectedRelationshipRevision: workspace.relationship_revision,
              }).catch(() => undefined);
            }}
            resolving={resolving}
          />
        </div>
      ) : null}
      <div className="sh-conflict-nav">
        <Button
          disabled={selectedIndex <= 0}
          onClick={() => step("prev")}
          size="sm"
          variant="ghost"
        >
          {t("relationships.decisions.nav.prev")}
        </Button>
        <span>
          {t("relationships.decisions.nav.position", {
            index: selectedIndex + 1,
            total: visibleQueue.length,
          })}
        </span>
        <Button
          disabled={selectedIndex < 0 || selectedIndex >= visibleQueue.length - 1}
          onClick={() => step("next")}
          size="sm"
          variant="ghost"
        >
          {t("relationships.decisions.nav.next")}
        </Button>
      </div>
      <section aria-label={t("relationships.decisions.queueLabel")} className="sh-conflict-queue">
        <ul>
          {visibleQueue.map((entry) => (
            <li key={entry.case.conflict_id}>
              <button
                aria-label={entry.case.conflict_id}
                className={
                  entry.case.conflict_id === selectedId
                    ? "sh-conflict-queue__row sh-conflict-queue__row--active"
                    : "sh-conflict-queue__row"
                }
                onClick={() => selectEntry(entry.case.conflict_id)}
                type="button"
              >
                <span className="sh-conflict-queue__id">{entry.case.conflict_id}</span>
                <span>
                  {t(
                    (KIND_CHIP_LABEL_KEYS[conflictKindGroup(entry)]
                      ?? KIND_CHIP_LABEL_KEYS.unknown) as never,
                  )}
                </span>
                {entry.latest_analysis ? (
                  <span className="sh-conflict-queue__analysis">
                    {entry.analysis_stale
                      ? t("relationships.decisions.ai.staleBadge")
                      : t("relationships.decisions.queue.hasConclusion")}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <ConflictHistory handled={handled} />
    </div>
  );
}

function ConflictHistory({
  handled,
}: {
  handled: readonly ConflictResolutionRecord[];
}): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale([i18n.resolvedLanguage ?? i18n.language]);
  if (handled.length === 0) return null;
  return (
    <section aria-labelledby="conflict-history-heading" className="sh-conflict-history">
      <h2 id="conflict-history-heading">{t("relationships.decisions.history.heading")}</h2>
      <ul>
        {handled.map((record) => (
          <li key={`${record.conflict_id}-${record.decided_at}`}>
            {/* DEV-15：历史行以用户可读信息为主——Skill 名称 + 结论 +
                本地化时间；裸冲突 id 与 unix 时间戳不再进界面。 */}
            <span>{readableTailOfId(record.conflict_id)}</span>
            <span>{t(conflictDecisionLabelKey(record.decision) as never)}</span>
            <span className="sh-settings-local-note">
              {t("relationships.decisions.history.concludedAs", {
                conclusion: t(`relationshipGovernance.conflictClassification.${record.conclusion}` as never),
              })}
            </span>
            <span className="sh-settings-local-note">
              {t("relationships.decisions.history.decidedAt", {
                date: formatTimestamp(record.decided_at, locale),
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
