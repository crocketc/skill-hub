import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { SkillRelation } from "./api";

export function RelationsPanel({
  relations,
  onUndeploy,
}: {
  relations: SkillRelation[];
  onUndeploy?: (relation: SkillRelation) => void;
}) {
  const { t } = useTranslation();
  const groups = new Map<string, SkillRelation[]>();
  for (const relation of relations) {
    groups.set(relation.physicalTarget, [...(groups.get(relation.physicalTarget) ?? []), relation]);
  }
  return (
    <div className="sh-detail-relations">
      {[...groups.entries()].map(([physicalTarget, items]) => (
        <section key={physicalTarget}>
          <p data-testid="physical-target">
            <strong>{t("skillDetail.relations.physicalTarget")}</strong> {physicalTarget}
          </p>
          <ul>
            {items.map((relation) => (
              <li data-testid="logical-target" key={relation.id}>
                <strong>{relation.label}</strong>
                <span>{relation.logicalTarget}</span>
                <span>{relation.version}</span>
                {relation.pinned ? <span>{t("skillDetail.relations.pinned")}</span> : null}
                {onUndeploy ? (
                  <Button
                    aria-label={t("skillDetail.relations.undeployTarget", { target: relation.label })}
                    onClick={() => onUndeploy(relation)}
                    size="sm"
                    variant="secondary"
                  >
                    {t("skillDetail.relations.undeploy")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
