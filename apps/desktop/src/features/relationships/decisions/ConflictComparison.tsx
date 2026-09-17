import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import type { ConflictCaseFact } from "../../../api/bindings";
import { StatusBadge } from "../../../ui/StatusBadge";
import { conflictClassificationLabelKey } from "../../relationshipGovernance/relationshipGovernance";

export interface ConflictComparisonProps {
  caseFact: ConflictCaseFact;
}

function evidenceLabel(
  value: boolean | null,
  keys: { match: string; mismatch: string; unknown: string },
  t: (key: string) => string,
): string {
  if (value === true) return t(keys.match);
  if (value === false) return t(keys.mismatch);
  return t(keys.unknown);
}

/**
 * 双侧对比区（任务 7）：把一个冲突组的成员并排铺开，确定性证据事实
 * 直接可读；不推断结论，基线分类只作为事实标注。
 */
export function ConflictComparison({ caseFact }: ConflictComparisonProps): JSX.Element {
  const { t } = useTranslation();
  const members = caseFact.members ?? [];

  return (
    <section aria-label={t("relationships.decisions.comparison.caseHeading", { id: caseFact.conflict_id })} className="sh-conflict-comparison">
      <h3>{t("relationships.decisions.comparison.caseHeading", { id: caseFact.conflict_id })}</h3>
      <p>
        <span className="sh-settings-local-note">
          {t("relationships.decisions.comparison.baselineLabel")}
        </span>{" "}
        <StatusBadge tone="info">
          {t(conflictClassificationLabelKey(caseFact.classification) as never)}
        </StatusBadge>
      </p>
      {members.length === 0 ? (
        <p>{t("relationships.decisions.comparison.noMembers")}</p>
      ) : (
        <div className="sh-conflict-comparison__members">
          {members.map((member, index) => (
            <article
              className="sh-conflict-comparison__member"
              key={member.path ?? member.fingerprint ?? index}
            >
              <h4>
                {t("relationships.decisions.comparison.memberHeading", {
                  index: index + 1,
                })}
              </h4>
              {member.path ? (
                <p>
                  <span className="sh-settings-local-note">
                    {t("relationships.decisions.comparison.pathLabel")}
                  </span>{" "}
                  <code>{member.path}</code>
                </p>
              ) : null}
              {member.fingerprint ? (
                <p>
                  <span className="sh-settings-local-note">
                    {t("relationships.decisions.comparison.fingerprintLabel")}
                  </span>{" "}
                  <code>{member.fingerprint}</code>
                </p>
              ) : null}
              {member.skill_id ? (
                <p>
                  <StatusBadge tone="neutral">
                    {t("relationships.decisions.comparison.memberSkillLabel")}
                  </StatusBadge>
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
      <div className="sh-conflict-comparison__evidence">
        <h4>{t("relationships.decisions.comparison.evidenceHeading")}</h4>
        <ul>
          <li>
            {evidenceLabel(
              caseFact.evidence.fingerprints_match,
              {
                match: "relationships.decisions.comparison.fingerprints.match",
                mismatch: "relationships.decisions.comparison.fingerprints.mismatch",
                unknown: "relationships.decisions.comparison.fingerprints.unknown",
              },
              (key) => t(key as never),
            )}
          </li>
          <li>
            {evidenceLabel(
              caseFact.evidence.names_match,
              {
                match: "relationships.decisions.comparison.names.match",
                mismatch: "relationships.decisions.comparison.names.mismatch",
                unknown: "relationships.decisions.comparison.names.unknown",
              },
              (key) => t(key as never),
            )}
          </li>
          <li>
            {t(
              caseFact.evidence.sufficient_identity_evidence
                ? "relationships.decisions.comparison.sufficientEvidence.yes"
                : "relationships.decisions.comparison.sufficientEvidence.no",
            )}
          </li>
        </ul>
      </div>
    </section>
  );
}
