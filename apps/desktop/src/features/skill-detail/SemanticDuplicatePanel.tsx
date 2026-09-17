import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { describeNativeError } from "../../api/nativeErrors";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { conflictWorkspaceHref } from "../relationships/decisions/conflictDecisions";
import {
  type SemanticDuplicateReport,
  type SkillDetailFacade,
} from "./api";

interface SemanticDuplicatePanelProps {
  facade: SkillDetailFacade;
  skillId: string;
  /** P1-12：来自 getInsights 的确定性重复候选（内容比对产物，与 AI 无关），
   * 页面加载即常显；可选 AI 分析在其上作为增强层，由用户显式触发。 */
  deterministicCandidates?: string[];
  /** 统一执行桥的在途投影；测试可注入独立实例，默认模块级单例。 */
  tracker?: OperationTracker;
}

/** Optional AI layer over the deterministic duplicate candidates (US-018).
 * The panel is user-initiated, shows the deterministic candidates even when
 * the AI layer fails, and never performs any action by itself: merging,
 * deleting or archiving always stays a separate explicit user decision.
 * 任务 7 清理：此处不再自带 Skill 维度冲突分析入口；冲突组的 AI 分析与
 * 裁决集中在冲突处理工作台，面板只保留确定性候选与工作台深链。 */
export function SemanticDuplicatePanel({
  deterministicCandidates = [],
  facade,
  skillId,
  tracker = operationTracker,
}: SemanticDuplicatePanelProps): JSX.Element {
  const { t } = useTranslation();
  const notifications = useOptionalAppNotifications();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<SemanticDuplicateReport>();
  const [error, setError] = useState<string>();
  // null 表示可用性查询尚未返回：按钮暂不可点，但不显示不可用文案。
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    facade
      .isAiAvailable()
      .then((available) => {
        if (!cancelled) setAiAvailable(available);
      })
      .catch(() => {
        if (!cancelled) setAiAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [facade]);

  const describeError = (reason: unknown) =>
    describeNativeError(
      reason,
      (key, options) => String(t(key as never, options as never)),
      "skillDetail.duplicates.failureUnknown",
    );

  const run = () => {
    if (running) return;
    setRunning(true);
    setError(undefined);
    // 统一执行桥（任务 4）：AI 分析进 tracker 在途投影，并同步进入
    // 通知中心；页面内仍保留可读错误与确定性候选，异常不吞掉。
    runTrackedOperation({
      tracker,
      notifications,
      kind: "ai_analysis",
      label: t("skillDetail.tracker.aiAnalysisLabel"),
      translate: (key, options) => String(t(key as never, options as never)),
      successNotice: () => ({ tone: "success", title: t("skillDetail.tracker.aiAnalysisLabel") }),
      errorNotice: (_error, message) => ({ tone: "danger", title: t("skillDetail.duplicates.runFailed", { message }), detail: message }),
      run: (handle) => {
        handle.phase(t("skillDetail.tracker.duplicatesPhase"));
        return facade.analyzeSemanticDuplicates(skillId);
      },
    })
      .then(setReport)
      // 结构化 AppError 直接 String() 会变成 "[object Object]"；
      // 统一走分类文案，并明确确定性候选不受影响。
      .catch((reason: unknown) => setError(describeError(reason)))
      .finally(() => setRunning(false));
  };

  const aiUnavailableCopy = aiAvailable === false;

  return (
    <section aria-labelledby="deterministic-duplicates-heading" className="sh-detail-insights">
      {/* 上段：确定性候选常显（数据来自 getInsights，无需点击，也不依赖 LLM）。 */}
      <div className="sh-metadata-panel__section-heading">
        <h3 id="deterministic-duplicates-heading">
          {t("skillDetail.duplicates.deterministicHeading")}
        </h3>
      </div>
      <p className="sh-settings-local-note">{t("skillDetail.duplicates.deterministicHint")}</p>
      {deterministicCandidates.length ? (
        <ul aria-label={t("skillDetail.duplicates.deterministicHeading")}>
          {deterministicCandidates.map((candidate) => (
            <li key={candidate}>{candidate}</li>
          ))}
        </ul>
      ) : (
        <p>{t("skillDetail.duplicates.noCandidates")}</p>
      )}
      {/* 下段：可选 AI 语义分析（用户显式触发；确定性结果不依赖它）。 */}
      <div className="sh-metadata-panel__section-heading">
        <h3 id="semantic-duplicates-heading">{t("skillDetail.duplicates.heading")}</h3>
        <Button
          disabled={running || aiUnavailableCopy}
          loading={running}
          onClick={run}
          size="sm"
          variant="ghost"
        >
          {t("skillDetail.duplicates.run")}
        </Button>
      </div>
      <p className="sh-settings-local-note">{t("skillDetail.duplicates.scopeNote")}</p>
      {aiUnavailableCopy ? (
        <p role="status">{t("skillDetail.duplicates.aiUnavailable")}</p>
      ) : null}
      {error ? (
        <>
          <p role="alert">{t("skillDetail.duplicates.runFailed", { message: error })}</p>
          <p role="status">{t("skillDetail.duplicates.deterministicNote")}</p>
        </>
      ) : null}
      {report ? (
        <>
          <p>
            {report.source === "llm"
              ? t("skillDetail.duplicates.sourceLlm")
              : t("skillDetail.duplicates.sourceDeterministic")}
          </p>
          {report.failureCode ? (
            <>
              {/* reason 自成立句、“确定性候选不受影响”独立成句渲染：
                  分隔不依赖 keyed 文案自带句尾标点的隐式不变量。 */}
              <p role="status">
                {t("skillDetail.duplicates.failureReason", {
                  reason: describeError({
                    code: report.failureCode,
                    severity: "error",
                    params: {},
                    actions: [],
                  }),
                })}
              </p>
              <p role="status">
                {t("skillDetail.duplicates.deterministicUnaffected")}
              </p>
            </>
          ) : null}
          {report.candidates.length ? (
            <section>
              <h4>{t("skillDetail.duplicates.candidates")}</h4>
              <ul aria-label={t("skillDetail.duplicates.candidates")}>
                {report.candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <strong>{candidate.name}</strong>
                    <span> · {candidate.description}</span>
                    {candidate.locallyModified ? (
                      <StatusBadge tone="warning">{t("skillDetail.duplicates.locallyModified")}</StatusBadge>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p>{t("skillDetail.duplicates.noCandidates")}</p>
          )}
          <p className="sh-settings-local-note">{t("skillDetail.duplicates.confirmationNote")}</p>
        </>
      ) : null}
      {/* 任务 7 清理：冲突组的 AI 分析与裁决集中在冲突处理工作台，
          这里只保留确定性候选与深链，不再自带 Skill 维度冲突分析入口。 */}
      <div className="sh-metadata-panel__section-heading">
        <h3>{t("relationships.decisions.panelHeading")}</h3>
      </div>
      <p>
        <Link to={conflictWorkspaceHref()}>{t("relationships.decisions.deepLink.label")}</Link>
      </p>
      <p className="sh-settings-local-note">{t("relationships.decisions.deepLink.hint")}</p>
    </section>
  );
}
