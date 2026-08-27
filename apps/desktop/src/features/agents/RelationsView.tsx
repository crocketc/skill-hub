import { useTranslation } from "react-i18next";
import type { AgentRelation } from "./api";

export interface RelationsViewProps {
  relations: AgentRelation[];
}

export function RelationsView({ relations }: RelationsViewProps) {
  const { t } = useTranslation();
  const physicalTargets = Array.from(new Map(relations.map((relation) => [relation.physicalTargetId, relation])).values());

  return (
    <section className="sh-agent-relations" aria-labelledby="agent-relations-title">
      <div className="sh-agent-section-heading">
        <div>
          <p className="sh-agent-eyebrow">{t("agents.relations.eyebrow")}</p>
          <h2 id="agent-relations-title">{t("agents.relations.title")}</h2>
        </div>
        <span>{t("agents.relations.count", { logical: relations.length, physical: physicalTargets.length })}</span>
      </div>
      <div className="sh-agent-relations__grid">
        {physicalTargets.map((physical) => (
          <article className="sh-agent-relations__physical" data-testid="physical-target" key={physical.physicalTargetId}>
            <strong>{t("agents.relations.physicalTarget")}</strong>
            <code>{physical.physicalPath}</code>
            <div className="sh-agent-relations__logical">
              {relations.filter((relation) => relation.physicalTargetId === physical.physicalTargetId).map((relation) => (
                <span data-testid="logical-target" key={relation.logicalTargetId}>{relation.logicalLabel}</span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
