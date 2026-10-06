import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import type { CandidateOwnership, ImportCandidate, ImportSecurityLevel, ImportSecurityPlan } from "./api";
import { displayPath } from "../../platform/displayPath";

export interface CandidateSelectionProps {
  candidates: ImportCandidate[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onSelectAll?: () => void;
  /**
   * 第 24 节：candidateId → 安全分级摘要（analyze 阶段由 prepare 产出）。
   * 缺省（尚未分析或环境未返回分级）时该候选行不显示安全徽标——未分级
   * 不冒充“放行”，风险仍在安全检测步与确定性导入门把守。
   */
  securityLevels?: ImportSecurityPlan;
}

const ownershipTone: Record<CandidateOwnership, "neutral" | "warning" | "info"> = {
  agent_builtin: "warning",
  managed: "info",
  other_tool: "warning",
  plugin: "warning",
  unknown: "neutral",
};

/** 第 24 节：安全分级徽标样式沿用全项目安全结果语义（绿=放行、黄/红=风险）。 */
const securityTone: Record<ImportSecurityLevel, "success" | "warning" | "danger"> = {
  danger: "danger",
  pass: "success",
  warning: "warning",
};

/** 候选审阅列表：批量选择与逐项勾选；返回/继续等流程动作在向导底部操作区。 */
export function CandidateSelection({
  candidates,
  selectedIds,
  onToggle,
  onSelectAll,
  securityLevels,
}: CandidateSelectionProps) {
  const { t } = useTranslation();

  return (
    <section className="sh-import-candidates" aria-labelledby="import-candidates-title">
      <div className="sh-import-candidates__heading">
        <div>
          <p className="sh-import-candidates__eyebrow">{t("importWorkflow.candidates.eyebrow")}</p>
          <h2 id="import-candidates-title">{t("importWorkflow.candidates.title")}</h2>
          <p>{t("importWorkflow.candidates.description")}</p>
        </div>
      </div>

      {candidates.length ? (
        <>
          {onSelectAll ? (
            <Button onClick={onSelectAll} variant="secondary">
              {t("importWorkflow.candidates.selectAll")}
            </Button>
          ) : null}
          <ul className="sh-import-candidates__list">
            {candidates.map((candidate) => {
              const checked = selectedIds.includes(candidate.id);
              return (
                <li className="sh-import-candidates__item" key={candidate.id}>
                  <label>
                    <input
                      aria-label={candidate.name}
                      checked={checked}
                      onChange={() => onToggle(candidate.id)}
                      type="checkbox"
                    />
                    <span className="sh-import-candidates__name">{candidate.name}</span>
                  </label>
                  <div className="sh-import-candidates__meta">
                    <StatusBadge tone={candidate.basicCheck === "passed" ? "success" : "neutral"}>
                      {t(`importWorkflow.candidates.basicCheck.${candidate.basicCheck}`)}
                    </StatusBadge>
                    {/* 第 24 节：分级数据存在时展示安全徽标（选择时风险即可见）。 */}
                    {securityLevels?.[candidate.id] ? (
                      <StatusBadge tone={securityTone[securityLevels[candidate.id].level]}>
                        {t(`importWorkflow.conflicts.security.level.${securityLevels[candidate.id].level}`)}
                      </StatusBadge>
                    ) : null}
                    <StatusBadge tone={ownershipTone[candidate.ownership]}>
                      {t(`importWorkflow.candidates.ownership.${candidate.ownership}`)}
                    </StatusBadge>
                    <code title={displayPath(candidate.path)}>{displayPath(candidate.path)}</code>
                    {/* DEV-3：文件夹名 ≠ SKILL.md name 的非阻塞警告——不拦截导入，
                        只提示部署时 Agent 看到的名称以文件夹名为准。 */}
                    {candidate.frontmatterName && candidate.frontmatterName !== candidate.name ? (
                      <StatusBadge tone="warning">
                        {t("importWorkflow.candidates.nameMismatch")}
                      </StatusBadge>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="sh-import-candidates__empty" role="status">
          {t("importWorkflow.candidates.empty")}
        </p>
      )}
    </section>
  );
}
