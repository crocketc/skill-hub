import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "../../ui/Button";
import { displayPath } from "../../platform/displayPath";
import type { RemovalItemOutcome, RemovalResult } from "./api";
import "./removal.css";

export interface RemovalOutcomeTargetLabel {
  label?: string;
  path?: string | null;
}

interface RemovalOutcomeResultProps {
  result: RemovalResult;
  /** 提交前预览里的目标显示名与路径；缺失时回退 deployment_id，绝不冒充成功。 */
  targetLabels?: Record<string, RemovalOutcomeTargetLabel>;
  /** 「继续处理（重新确认）」入口：按契约必须先重新 prepare，再重新确认。 */
  onContinue?: () => void;
  continuing?: boolean;
}

/**
 * 统一 presenter：逐项错误码 → 可读文案键（点号转下划线避开 i18n 嵌套键）。
 * 未知错误码由调用方 defaultValue 回退到通用原因，绝不裸露内部枚举。
 */
export function removalItemErrorKey(errorCode: string): string {
  return `removal.outcome.errorCodes.${errorCode.replaceAll(".", "_")}`;
}

function outcomeItemLabel(item: RemovalItemOutcome, targetLabels?: Record<string, RemovalOutcomeTargetLabel>): string {
  return targetLabels?.[item.deploymentId]?.label?.trim() || item.deploymentId;
}

function outcomeItemPath(item: RemovalItemOutcome, targetLabels?: Record<string, RemovalOutcomeTargetLabel>): string | null {
  return targetLabels?.[item.deploymentId]?.path ?? null;
}

/**
 * 多目标删除逐项结果面板（K2 故障矩阵：第 N 项删除失败 / delete_skill 失败）：
 * applied/failed/pending 三态分列（pending 排在失败组之后，文案区分「失败」与
 * 「未尝试」）、失败项错误码经统一 presenter 映射为可读原因、中央删除失败时
 * 标题明示「目标已回收，中央 Skill 未删除」并给出恢复中心入口。部分成功绝不
 * 冒充全部完成；中央 Skill 未删除的事实直接可见。
 */
export function RemovalOutcomeResult({ continuing = false, onContinue, result, targetLabels }: RemovalOutcomeResultProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const items = result.items ?? [];
  const applied = items.filter((item) => item.status === "applied");
  const failed = items.filter((item) => item.status === "failed");
  const pending = items.filter((item) => item.status === "pending");
  // 绑定注释：state 旧载荷缺省按已提交读取。
  const state = result.state ?? (result.centralSkillDeleted ? "committed" : "partially_committed");
  const notDeleted = failed.length + pending.length;
  // K2 故障矩阵：delete_skill 失败 → 关系决定已执行、中央仍在。该状态与
  // 逐项目标失败共用本面板，但标题区分：中央失败事实优先于逐项 partial 说明。
  const centralDeleteFailed = state === "partially_committed" && Boolean(result.centralDeleteError);
  return (
    <div aria-label={t("removal.outcome.title")} className="sh-removal-outcome" data-testid="removal-outcome-result" role="status">
      <p data-testid="removal-outcome-title">
        {centralDeleteFailed
          ? t("removal.outcome.centralDeleteFailed")
          : notDeleted === 0
            ? t("removal.outcome.applied", { count: applied.length })
            : applied.length > 0
              ? t("removal.outcome.partial", { applied: applied.length, failed: notDeleted })
              : t("removal.outcome.failed")}
      </p>
      {applied.length > 0 ? (
        <section className="sh-removal-outcome__group" data-testid="removal-outcome-applied">
          <h4>{t("removal.outcome.appliedGroup")}</h4>
          <ul>
            {applied.map((item) => {
              const path = outcomeItemPath(item, targetLabels);
              return (
                <li key={item.deploymentId}>
                  <span>{outcomeItemLabel(item, targetLabels)}</span>
                  {path ? <small>{displayPath(path)}</small> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {failed.length > 0 ? (
        <section className="sh-removal-outcome__group" data-testid="removal-outcome-failed">
          <h4>{t("removal.outcome.failedGroup")}</h4>
          <ul>
            {failed.map((item) => {
              const path = outcomeItemPath(item, targetLabels);
              return (
                <li key={item.deploymentId}>
                  <span>{outcomeItemLabel(item, targetLabels)}</span>
                  {path ? <small>{displayPath(path)}</small> : null}
                  {/* 可读原因来自错误码统一映射；未知错误码回退通用文案，不裸露枚举。 */}
                  <small>
                    {item.errorCode
                      ? t(removalItemErrorKey(item.errorCode), { defaultValue: t("removal.outcome.reasonUnknown") })
                      : t("removal.outcome.reasonUnknown")}
                  </small>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {pending.length > 0 ? (
        <section className="sh-removal-outcome__group" data-testid="removal-outcome-pending">
          <h4>{t("removal.outcome.pendingGroup")}</h4>
          <ul>
            {pending.map((item) => {
              const path = outcomeItemPath(item, targetLabels);
              return (
                <li key={item.deploymentId}>
                  <span>{outcomeItemLabel(item, targetLabels)}</span>
                  {path ? <small>{displayPath(path)}</small> : null}
                  {/* 未尝试 ≠ 失败：恢复后继续处理，不重复已成功项。 */}
                  <small>{t("removal.outcome.pendingReason")}</small>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {centralDeleteFailed && result.recoveryOperationId ? (
        <div className="sh-removal-outcome__actions">
          <Button
            data-testid="removal-outcome-recovery"
            onClick={() => navigate(`/recovery?operationId=${encodeURIComponent(result.recoveryOperationId ?? "")}`)}
            variant="secondary"
          >
            {t("removal.outcome.openRecovery")}
          </Button>
        </div>
      ) : null}
      {notDeleted > 0 && onContinue ? (
        <div className="sh-removal-outcome__actions">
          <Button
            data-testid="removal-outcome-continue"
            disabled={continuing}
            onClick={onContinue}
            variant="secondary"
          >
            {continuing ? t("removal.outcome.continuing") : t("removal.outcome.continue")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
