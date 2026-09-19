import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import type { CandidateOwnership, ImportCandidate } from "./api";
import { displayPath } from "../../platform/displayPath";

export interface CandidateSelectionProps {
  candidates: ImportCandidate[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onSelectAll?: () => void;
}

const ownershipTone: Record<CandidateOwnership, "neutral" | "warning" | "info"> = {
  agent_builtin: "warning",
  managed: "info",
  other_tool: "warning",
  plugin: "warning",
  unknown: "neutral",
};

/** 候选审阅列表：批量选择与逐项勾选；返回/继续等流程动作在向导底部操作区。 */
export function CandidateSelection({
  candidates,
  selectedIds,
  onToggle,
  onSelectAll,
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
