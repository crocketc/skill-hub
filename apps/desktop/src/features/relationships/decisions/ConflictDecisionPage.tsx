import { useCallback, useEffect, useState, type JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { CommitUsageChange, ConflictResolutionRecord, ConflictWorkspaceCase, EnvironmentProblemView, UsageChangeResult } from "../../../api/bindings";
import { formatTimestamp, readableTailOfId, resolveLocale } from "../../../i18n";
import { Button } from "../../../ui/Button";
import { DataState } from "../../../ui/DataState";
import { describeNativeError } from "../../../api/nativeErrors";
import {
  useOptionalAppNotifications,
  type AppNotifications,
} from "../../../ui/notifications";
import { runTrackedOperation } from "../../../platform/runTrackedOperation";
import { relationshipsKeys } from "../api";
import { nativeGovernanceFacade } from "../governance/nativeApi";
import type { RelationGovernanceFacade } from "../governance/api";
import { DuplicateCleanupDialog } from "../governance/DuplicateCleanupDialog";
import type { UsageChangeFacade } from "../../removal/api";
import { nativeUsageChangeFacade } from "../../removal/nativeApi";
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
import "../governance/governance.css";

export interface ConflictDecisionPageProps {
  /** 缺省为原生只读投影 + 显式命令门面；测试注入替身。 */
  facade?: ConflictDecisionsFacade;
  /** 统一执行桥的在途投影；测试可注入独立实例。 */
  tracker?: OperationTracker;
  /** 通知中心；缺省取上下文（AppShell 内存在 Provider）。 */
  notifications?: AppNotifications | null;
  /** 当前 Agent／项目问题的只读重扫门面；测试可注入。 */
  environmentFacade?: Pick<RelationGovernanceFacade, "getUsageEnvironmentProblems">;
  /** 重复清理仍使用统一 prepare／commit 契约。 */
  usageChangeFacade?: UsageChangeFacade;
}

const KIND_CHIP_LABEL_KEYS: Record<string, string> = {
  duplicate_same_content: "relationships.decisions.kind.duplicate_same_content",
  same_name_different_content: "relationships.decisions.kind.same_name_different_content",
};

/**
 * 冲突处理工作台（任务 7）：默认队列只含 DTO 给出的待确认 uncertain 冲突
 * （不在前端另行过滤）；类别 chip + 前后导航；已处理项只进历史；
 * AI 可选且从不阻塞人工决定；文件类决定只携带上下文跳治理预览。
 */
export function ConflictDecisionPage({
  facade = nativeConflictDecisionsFacade,
  environmentFacade = nativeGovernanceFacade,
  notifications,
  tracker = operationTracker,
  usageChangeFacade = nativeUsageChangeFacade,
}: ConflictDecisionPageProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const contextNotifications = useOptionalAppNotifications();
  const effectiveNotifications: AppNotifications | null =
    notifications !== undefined ? notifications : contextNotifications;

  const workspaceQuery = useConflictWorkspace(facade);
  const problemIdParam = searchParams.get("problemId");
  const environmentProblemQuery = useQuery({
    queryFn: () => environmentFacade.getUsageEnvironmentProblems(),
    queryKey: relationshipsKeys.governanceUsageProblems(problemIdParam),
    enabled: Boolean(problemIdParam?.trim()),
  });
  const environmentProblem = environmentProblemQuery.data?.problems.find(
    (problem) => problem.problem_id === problemIdParam && !problem.closed,
  ) ?? null;
  const [duplicateCleanupOpen, setDuplicateCleanupOpen] = useState(false);
  const [cleanupProblemSnapshot, setCleanupProblemSnapshot] = useState<EnvironmentProblemView | null>(null);
  useEffect(() => {
    setDuplicateCleanupOpen(false);
    setCleanupProblemSnapshot(null);
  }, [problemIdParam]);
  const { available: aiAvailable } = useConflictAiAvailability(facade);
  const ai = useConflictAiAnalysis({ facade, tracker });
  const workspace = workspaceQuery.data;
  const cases = workspace?.cases ?? [];
  const handled = workspace?.handled ?? [];
  const deterministicHistory = workspace?.deterministic_history ?? [];
  const historyCount = handled.length + deterministicHistory.length;

  const categoryParam = searchParams.get("category");
  const conflictIdParam = searchParams.get("conflictId");
  const isProductCategory = categoryParam === "duplicate_same_content"
    || categoryParam === "same_name_different_content";
  const visibleQueue = isProductCategory
    ? cases.filter((entry) => conflictKindGroup(entry) === categoryParam)
    : cases;
  const selectedId =
    conflictIdParam && visibleQueue.some((entry) => entry.case.conflict_id === conflictIdParam)
      ? conflictIdParam
      : conflictIdParam ? null : visibleQueue[0]?.case.conflict_id ?? null;
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

  const describeError = useCallback((reason: unknown) => describeNativeError(
    reason,
    (key, options) => String(t(key as never, options as never)),
    "tasks.notices.failureUnknown",
  ), [t]);

  const commitDuplicateCleanup = useCallback((request: CommitUsageChange): Promise<UsageChangeResult> => (
    runTrackedOperation<UsageChangeResult>({
      targetHref: `${location.pathname}${location.search}`,
      canCancel: false,
      describeError,
      invalidateQueryKeys: [[relationshipsKeys.root]],
      kind: "usage_duplicate_cleanup",
      label: t("relationships.governance.duplicateCleanup.title"),
      notifications: effectiveNotifications,
      queryClient,
      run: async (handle) => {
        handle.correlate(request.operation_id);
        return usageChangeFacade.commitUsageChange(request);
      },
      successNotice: (result) => result.recovery_required
        ? null
        : { title: t("relationships.governance.duplicateCleanup.title"), tone: "success" as const },
      summarize: (result) => ({
        failed: result.recovery_required ? 1 : 0,
        skipped: 0,
        succeeded: result.recovery_required ? 0 : 1,
      }),
      total: 1,
      tracker,
      translate: (key, options) => String(t(key as never, options as never)),
    })
  ), [describeError, effectiveNotifications, location.pathname, location.search, queryClient, t, tracker, usageChangeFacade]);

  const safeReturnTo = (() => {
    const value = searchParams.get("returnTo");
    return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
      ? value
      : null;
  })();
  const returnToIssue = () => {
    setDuplicateCleanupOpen(false);
    if (safeReturnTo) navigate(safeReturnTo);
  };

  const renderEnvironmentProblem = () => {
    if (!problemIdParam) return null;
    const displayedProblem = environmentProblem
      ?? (duplicateCleanupOpen && cleanupProblemSnapshot?.problem_id === problemIdParam
        ? cleanupProblemSnapshot
        : null);
    if (environmentProblemQuery.isPending && !displayedProblem) {
      return <p role="status">{t("relationships.governance.problemContext.loading")}</p>;
    }
    if (environmentProblemQuery.isError && !displayedProblem) {
      return <p role="alert">{t("relationships.governance.problemContext.unavailable")}</p>;
    }
    if (!displayedProblem) {
      return <p role="status">{t("relationships.governance.problemContext.stale")}</p>;
    }
    return (
      <section aria-labelledby="environment-problem-heading" className="sh-conflict-environment">
        <div className="sh-conflict-workbench">
          <div className="sh-conflict-environment__facts">
            <h2 id="environment-problem-heading">
              {t(displayedProblem.kind === "same_skill"
                ? "pending.environmentProblemTitles.sameSkill"
                : "pending.environmentProblemTitles.nameConflict")}
            </h2>
            <p>{t(`pending.reasons.environment_problem.${displayedProblem.kind}` as never)}</p>
            <ul className="sh-governance__duplicate-entries">
              {displayedProblem.entries.map((entry, index) => {
                const path = fullEntryPath(entry.directory_path, entry.relative_entry_path);
                return (
                  <li key={`${entry.directory_id}:${entry.relative_entry_path}:${index}`}>
                    <span className="sh-governance__duplicate-entry-role">
                      {directoryRoleLabel(entry.directory_role, (key) => String(t(key as never)))}
                    </span>
                    <code className="sh-governance__duplicate-entry-path" title={path}>{path}</code>
                  </li>
                );
              })}
            </ul>
          </div>
          <ConflictActions
            mode="environment_problem"
            onNotNow={() => {
              setDuplicateCleanupOpen(false);
              setCleanupProblemSnapshot(null);
              returnToIssue();
            }}
            onResolveDuplicate={() => {
              setCleanupProblemSnapshot(displayedProblem);
              setDuplicateCleanupOpen(true);
            }}
            problem={displayedProblem}
          />
        </div>
        {duplicateCleanupOpen && displayedProblem.kind === "same_skill" ? (
          <DuplicateCleanupDialog
            onClose={() => {
              setDuplicateCleanupOpen(false);
              setCleanupProblemSnapshot(null);
            }}
            onCommit={commitDuplicateCleanup}
            onCompleted={() => undefined}
            onPrepare={usageChangeFacade.prepareUsageChange}
            problem={displayedProblem}
          />
        ) : null}
      </section>
    );
  };

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
        {renderEnvironmentProblem()}
        {!problemIdParam ? (
          <DataState
            message={
              historyCount > 0
                ? t("relationships.decisions.empty.allDone", {
                    count: historyCount,
                  })
                : t("relationships.decisions.empty.none")
            }
            hint={t("relationships.decisions.empty.hint")}
            state="empty"
          />
        ) : null}
        {historyCount > 0 ? (
          <ConflictHistory deterministic={deterministicHistory} handled={handled} />
        ) : null}
      </div>
    );
  }

  const kindChips = queueKindValues(cases);

  return (
    <div className="sh-conflict-page">
      {renderEnvironmentProblem()}
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
      {conflictIdParam && !selectedEntry ? <p role="status">{t("pending.linkResolved")}</p> : null}
      <div className="sh-conflict-page__chips" role="group" aria-label={t("relationships.decisions.chipsLabel")}>
        <Button
          aria-pressed={!isProductCategory}
          onClick={clearCategory}
          size="sm"
          variant={!isProductCategory ? "secondary" : "ghost"}
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
            mode="case"
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
                    (conflictKindGroup(entry)
                      ? KIND_CHIP_LABEL_KEYS[conflictKindGroup(entry)!]
                      : "relationships.decisions.kind.unclassified") as never,
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
      <ConflictHistory deterministic={deterministicHistory} handled={handled} />
    </div>
  );
}

function fullEntryPath(directoryPath: string | null | undefined, relativePath: string): string {
  if (!directoryPath) return relativePath;
  const separator = directoryPath.includes("\\") ? "\\" : "/";
  return `${directoryPath.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/[\\/]+/g, separator)}`;
}

function directoryRoleLabel(role: string | null | undefined, translate: (key: string) => string): string {
  if (role === "builtin") return translate("agents.directoryRole.builtin");
  if (role === "agent_user" || role === "agent_native") return translate("agents.directoryRole.user");
  if (role === "agent_workspace" || role === "project") return translate("agents.directoryRole.workspace");
  if (role === "shared_directory") return translate("relationships.governance.duplicateCleanup.sharedDirectory");
  return translate("relationships.governance.duplicateCleanup.unknownDirectory");
}

function ConflictHistory({
  handled,
  deterministic,
}: {
  handled: readonly ConflictResolutionRecord[];
  deterministic: readonly ConflictWorkspaceCase[];
}): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale([i18n.resolvedLanguage ?? i18n.language]);
  if (handled.length === 0 && deterministic.length === 0) return null;
  return (
    <section aria-labelledby="conflict-history-heading" className="sh-conflict-history">
      <h2 id="conflict-history-heading">{t("relationships.decisions.history.heading")}</h2>
      <ul>
        {deterministic.map((entry) => (
          <li key={`deterministic-${entry.case.conflict_id}`}>
            <span>{t("relationships.decisions.history.deterministicLabel")}</span>
            <span className="sh-settings-local-note">
              {t("relationships.decisions.history.deterministicDescription")}
            </span>
          </li>
        ))}
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
