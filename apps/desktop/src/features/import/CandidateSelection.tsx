import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import type { CandidateOwnership, ImportCandidate } from "./api";

export interface CandidateSelectionProps {
  candidates: ImportCandidate[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onContinue: () => void;
  onBack: () => void;
}

const ownershipTone: Record<CandidateOwnership, "neutral" | "warning" | "info"> = {
  agent_builtin: "warning",
  managed: "info",
  other_tool: "warning",
  plugin: "warning",
  unknown: "neutral",
};

export function CandidateSelection({
  candidates,
  selectedIds,
  onToggle,
  onContinue,
  onBack,
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
        <span className="sh-import-candidates__step">{t("importWorkflow.step", { current: 2, total: 4 })}</span>
      </div>

      {candidates.length ? (
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
                  <code title={candidate.path}>{candidate.path}</code>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="sh-import-candidates__empty" role="status">
          {t("importWorkflow.candidates.empty")}
        </p>
      )}

      <div className="sh-import-candidates__actions">
        <Button onClick={onBack} variant="ghost">
          {t("actions.back")}
        </Button>
        <Button disabled={!selectedIds.length} onClick={onContinue}>
          {t("actions.continue")}
        </Button>
      </div>
    </section>
  );
}
