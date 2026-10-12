import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { Drawer } from "../../ui/Drawer";
import { Icon } from "../../ui/Icon";
import type { RemovalChoice, RemovalDeployment, RemovalImpact } from "../removal/api";
import { RemovalDeploymentTarget, RemovalImpactMatrix } from "../removal/RemovalImpactPieces";
import { displayPath } from "../../platform/displayPath";
import "./batchRemovalDrawer.css";

const LINK_MODES: ReadonlySet<NonNullable<RemovalDeployment["mode"]>> = new Set([
  "symbolic_link",
  "directory_junction",
]);

function isLinkDeployment(deployment: RemovalDeployment): boolean {
  return deployment.mode !== undefined && LINK_MODES.has(deployment.mode);
}

function defaultChoices(impacts: readonly RemovalImpact[]): Record<string, Record<string, RemovalChoice>> {
  return Object.fromEntries(impacts.map((impact) => [
    impact.operationId ?? "",
    Object.fromEntries(impact.deployments.map((deployment) => [
      deployment.id,
      isLinkDeployment(deployment) ? "remove_deployment" : "convert_to_copy",
    ])),
  ]));
}

function sharedDeploymentIds(impact: RemovalImpact): Set<string> {
  const targetCounts = new Map<string, number>();
  for (const deployment of impact.deployments) {
    if (deployment.targetId) {
      targetCounts.set(deployment.targetId, (targetCounts.get(deployment.targetId) ?? 0) + 1);
    }
  }
  return new Set(impact.deployments
    .filter((deployment) => deployment.targetId && (targetCounts.get(deployment.targetId) ?? 0) > 1)
    .map((deployment) => deployment.id));
}

type SharedConfirmations = Record<string, ReadonlySet<string>>;

/**
 * Batch review keeps the single-delete contract: links are removed, full copies
 * are kept independently by default, and removing a shared target needs an
 * explicit per-entry confirmation.
 */
export interface BatchRemovalDrawerProps {
  commitAllowed?: boolean;
  error?: string;
  impacts: RemovalImpact[];
  onCancel: () => void;
  onConfirm: (
    choices: Record<string, Record<string, RemovalChoice>>,
    confirmedSharedTargets: SharedConfirmations,
  ) => void | Promise<void>;
  submitting?: boolean;
}

export function BatchRemovalDrawer({
  commitAllowed = true,
  error,
  impacts,
  onCancel,
  onConfirm,
  submitting = false,
}: BatchRemovalDrawerProps): JSX.Element {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<Record<string, Record<string, RemovalChoice>>>(() => defaultChoices(impacts));
  const [confirmedSharedTargets, setConfirmedSharedTargets] = useState<SharedConfirmations>({});
  const [armed, setArmed] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previousImpactsRef = useRef(impacts);
  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
  useEffect(() => {
    if (previousImpactsRef.current === impacts) return;
    previousImpactsRef.current = impacts;
    setChoices(defaultChoices(impacts));
    setConfirmedSharedTargets({});
    setArmed(false);
  }, [impacts]);

  // QA-001: the first click summarizes the destructive choice; the second
  // click commits it. The action is disabled until any shared-target choices
  // have been explicitly confirmed.
  const count = impacts.length;
  const anyDeployments = impacts.some((impact) => impact.deployments.length > 0);
  const linkCount = impacts.reduce((total, impact) => total + impact.deployments.filter(isLinkDeployment).length, 0);
  const copyCount = impacts.reduce((total, impact) => total + impact.deployments.filter((deployment) => !isLinkDeployment(deployment)).length, 0);
  const requiresSharedConfirmations = impacts.flatMap((impact) => {
    const operationId = impact.operationId ?? "";
    return [...sharedDeploymentIds(impact)]
      .filter((deploymentId) => choices[operationId]?.[deploymentId] === "remove_deployment")
      .map((deploymentId) => ({ operationId, deploymentId }));
  });
  const complete = requiresSharedConfirmations.every(({ operationId, deploymentId }) =>
    confirmedSharedTargets[operationId]?.has(deploymentId),
  );

  const toggleSharedConfirmation = (operationId: string, deploymentId: string, confirmed: boolean) => {
    setConfirmedSharedTargets((current) => {
      const next = new Set(current[operationId] ?? []);
      if (confirmed) next.add(deploymentId);
      else next.delete(deploymentId);
      return { ...current, [operationId]: next };
    });
  };

  const confirmChoices = () => {
    void onConfirm(
      Object.fromEntries(impacts.map((impact) => [
        impact.operationId ?? "",
        choices[impact.operationId ?? ""] ?? {},
      ])),
      confirmedSharedTargets,
    );
  };

  return (
    <Drawer
      description={t("removal.batch.description", { count })}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open
      panelClassName="sh-skill-library__removal-drawer"
      returnFocusRef={returnFocusRef}
      title={t("removal.batch.heading")}
    >
      <div className="sh-skill-library__removal">
        <section aria-label={t("removal.summary.title")} className="sh-removal-impact__summary">
          <h3 className="sh-removal-impact__summary-title">{t("removal.summary.title")}</h3>
          <ul className="sh-removal-impact__summary-lines">
            <li>{t("removal.batch.summary.skills", { count })}</li>
            {linkCount > 0 ? <li>{t("removal.summary.links", { count: linkCount })}</li> : null}
            {copyCount > 0 ? <li>{t("removal.summary.copies", { count: copyCount })}</li> : null}
          </ul>
        </section>
        <div className="sh-skill-library__removal-disclaimer">
          <p>{t("removal.retained")}</p>
          <p>{t("removal.recovery")}</p>
        </div>
        {impacts.map((impact) => {
          const operationId = impact.operationId ?? "";
          const links = impact.deployments.filter(isLinkDeployment);
          const copies = impact.deployments.filter((deployment) => !isLinkDeployment(deployment));
          const sharedIds = sharedDeploymentIds(impact);
          return (
            <section className="sh-skill-library__removal-skill" key={impact.operationId ?? impact.skillId}>
              <h3>{impact.skillName}</h3>
              {impact.deployments.length === 0 ? <p>{t("removal.batch.noDeployments")}</p> : null}
              {impact.deployments.length > 0 ? (
                <ul className="sh-usage-release-impact__items">
                  {links.map((deployment) => (
                    <li key={deployment.id}>
                      <RemovalDeploymentTarget deployment={deployment} />
                      <p className="sh-removal-impact__fixed-outcome">{t("removal.groups.linkWillBeDeleted")}</p>
                    </li>
                  ))}
                  {copies.map((deployment) => {
                    const needsSharedConfirmation = sharedIds.has(deployment.id)
                      && choices[operationId]?.[deployment.id] === "remove_deployment";
                    return (
                      <li key={deployment.id}>
                        <RemovalDeploymentTarget deployment={deployment} />
                        <fieldset
                          aria-label={`${t("removal.choiceLabel")}: ${displayPath(deployment.path)}`}
                          className="sh-removal-impact__choice"
                        >
                          <label className="sh-removal-impact__choice-option">
                            <input
                              checked={choices[operationId]?.[deployment.id] === "convert_to_copy"}
                              name={`removal-choice-${operationId}-${deployment.id}`}
                              onChange={() => setChoices((current) => ({
                                ...current,
                                [operationId]: { ...current[operationId], [deployment.id]: "convert_to_copy" },
                              }))}
                              type="radio"
                              value="convert_to_copy"
                            />
                            <span className="sh-removal-impact__choice-text">
                              <span>{t("removal.groups.copyKeep")}</span>
                              <small>{t("removal.groups.copyKeepHint")}</small>
                            </span>
                          </label>
                          <label className="sh-removal-impact__choice-option">
                            <input
                              checked={choices[operationId]?.[deployment.id] === "remove_deployment"}
                              name={`removal-choice-${operationId}-${deployment.id}`}
                              onChange={() => setChoices((current) => ({
                                ...current,
                                [operationId]: { ...current[operationId], [deployment.id]: "remove_deployment" },
                              }))}
                              type="radio"
                              value="remove_deployment"
                            />
                            <span className="sh-removal-impact__choice-text">
                              <span>{t("removal.groups.copyDelete")}</span>
                              <small>{t("removal.groups.copyDeleteHint")}</small>
                            </span>
                          </label>
                        </fieldset>
                        {needsSharedConfirmation ? (
                          <label className="sh-removal-impact__shared-confirm">
                            <input
                              checked={confirmedSharedTargets[operationId]?.has(deployment.id) ?? false}
                              onChange={(event) => toggleSharedConfirmation(operationId, deployment.id, event.target.checked)}
                              type="checkbox"
                            />
                            <span>{t("removal.groups.sharedConfirm")}</span>
                          </label>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              <RemovalImpactMatrix impact={impact} />
            </section>
          );
        })}
        {error ? <p role="alert">{error}</p> : null}
        {submitting ? (
          <p className="sh-skill-library__removal-status" role="status">
            <Icon aria-hidden="true" name="info" size={16} />
            {t("removal.batch.busy", { count })}
          </p>
        ) : null}
        <footer className="sh-skill-library__removal-actions">
          <Button disabled={submitting} onClick={onCancel} variant="secondary">
            {t("actions.cancel")}
          </Button>
          <small className="sh-skill-library__removal-risk">{t("removal.batch.nonAtomicNotice")}</small>
          {armed ? (
            <Button disabled={submitting || !commitAllowed || !complete} onClick={confirmChoices} variant="danger">
              {t("removal.batch.armConfirm", { count })}
            </Button>
          ) : (
            <Button disabled={!commitAllowed || !complete || submitting} onClick={() => setArmed(true)} variant="danger">
              {anyDeployments ? t("removal.batch.continue") : t("removal.batch.deleteAll")}
            </Button>
          )}
        </footer>
      </div>
    </Drawer>
  );
}
