import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { displayPath } from "../../platform/displayPath";
import "./removal.css";

/**
 * K2 接线项（多目标删除逐项结果）：形态对齐既有 `RelationGovernanceBatchOutcome`
 * 的逐项建模，但字段命名以 A 侧对 `DeploymentRemovalResult` 的扩展提案为准，
 * 落地后与生成绑定对齐；在此之前本类型只服务组件级测试与预览，不接入
 * 真实提交链路，也不手改 bindings.ts。
 */
export type RemovalTargetOutcomeState = "applied" | "failed";

export interface RemovalTargetOutcome {
  deployment_id: string;
  /** 目标显示名；缺失时回退 deployment_id 展示，绝不冒充成功。 */
  label: string;
  path: string | null;
  state: RemovalTargetOutcomeState;
  /** 后端错误码：只用于映射可读原因，绝不原样暴露给用户。 */
  error_code: string | null;
  /** 后端给出的可读原因；优先于错误码映射呈现。 */
  detail: string | null;
  retryable: boolean;
}

export type RemovalOutcomeState = "applied" | "partially_applied" | "failed";

export interface RemovalOutcome {
  operation_id: string;
  state: RemovalOutcomeState;
  items: RemovalTargetOutcome[];
  applied_count: number;
  failed_count: number;
}

interface RemovalOutcomeResultProps {
  outcome: RemovalOutcome;
  /** 「继续处理（重新确认）」入口：按契约必须先重新 prepare，再重新确认。 */
  onContinue?: () => void;
  continuing?: boolean;
}

/**
 * 多目标删除逐项结果面板（K2 故障矩阵：第 N 项删除失败）：成功项/失败项
 * 分列、失败项带可读原因、提供「继续处理（重新确认）」入口。部分成功绝不
 * 冒充全部完成；中央 Skill 未删除的事实直接可见。
 */
export function RemovalOutcomeResult({ continuing = false, onContinue, outcome }: RemovalOutcomeResultProps) {
  const { t } = useTranslation();
  const applied = outcome.items.filter((item) => item.state === "applied");
  const failed = outcome.items.filter((item) => item.state === "failed");
  return (
    <div aria-label={t("removal.outcome.title")} className="sh-removal-outcome" data-testid="removal-outcome-result" role="status">
      <p data-testid="removal-outcome-title">
        {outcome.state === "applied"
          ? t("removal.outcome.applied", { count: outcome.applied_count })
          : outcome.state === "partially_applied"
            ? t("removal.outcome.partial", { applied: outcome.applied_count, failed: outcome.failed_count })
            : t("removal.outcome.failed")}
      </p>
      {applied.length > 0 ? (
        <section className="sh-removal-outcome__group" data-testid="removal-outcome-applied">
          <h4>{t("removal.outcome.appliedGroup")}</h4>
          <ul>
            {applied.map((item) => (
              <li key={item.deployment_id}>
                <span>{item.label}</span>
                {item.path ? <small>{displayPath(item.path)}</small> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {failed.length > 0 ? (
        <section className="sh-removal-outcome__group" data-testid="removal-outcome-failed">
          <h4>{t("removal.outcome.failedGroup")}</h4>
          <ul>
            {failed.map((item) => (
              <li key={item.deployment_id}>
                <span>{item.label}</span>
                {item.path ? <small>{displayPath(item.path)}</small> : null}
                {/* 可读原因优先取后端 detail；未知错误码不裸露枚举。 */}
                <small>{item.detail?.trim() ? t("removal.outcome.reasonDetail", { detail: item.detail }) : t("removal.outcome.reasonUnknown")}</small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {failed.length > 0 && onContinue ? (
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
