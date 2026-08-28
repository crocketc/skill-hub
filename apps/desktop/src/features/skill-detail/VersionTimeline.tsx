import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { skillLibraryKeys } from "../skills/api";
import type { SkillDetailFacade, SkillDetailSummary } from "./api";
import { skillDetailKeys } from "./api";
import { VersionUpdateNotice } from "./VersionUpdateNotice";

interface VersionTimelineProps {
  facade: SkillDetailFacade;
  skillId: string;
  summary?: SkillDetailSummary;
}

function toggleComparedVersion(selected: string[], versionId: string): string[] {
  if (selected.includes(versionId)) return selected.filter((id) => id !== versionId);
  return selected.length === 2 ? [selected[1], versionId] : [...selected, versionId];
}

export function VersionTimeline({ facade, skillId, summary }: VersionTimelineProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [compareRequested, setCompareRequested] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<string>();
  const [commitPending, setCommitPending] = useState(false);
  const [commitError, setCommitError] = useState<string>();
  const commitGuardRef = useRef(false);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);

  const versionsQuery = useQuery({
    queryFn: () => facade.getVersions(skillId),
    queryKey: skillDetailKeys.versions(skillId),
  });
  const diffQuery = useQuery({
    enabled: compareRequested && selected.length === 2,
    queryFn: () => facade.getVersionDiff(skillId, selected[0], selected[1]),
    queryKey: selected.length === 2
      ? skillDetailKeys.versionDiff(skillId, selected[0], selected[1])
      : [...skillDetailKeys.versions(skillId), "comparison-idle"],
  });
  const impactQuery = useQuery({
    enabled: Boolean(rollbackTarget),
    queryFn: () => facade.getRollbackImpact(skillId, rollbackTarget ?? ""),
    queryKey: rollbackTarget
      ? skillDetailKeys.rollbackImpact(skillId, rollbackTarget)
      : [...skillDetailKeys.versions(skillId), "rollback-idle"],
  });

  const prepareRollback = (versionId: string) => {
    setCommitError(undefined);
    setRollbackTarget(versionId);
    queueMicrotask(() => previewHeadingRef.current?.focus());
  };
  const commitRollback = () => {
    if (!rollbackTarget || commitGuardRef.current || !impactQuery.data) return;
    commitGuardRef.current = true;
    setCommitPending(true);
    setCommitError(undefined);
    void facade.commitRollback(skillId, rollbackTarget).then(
      async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: skillDetailKeys.versions(skillId) }),
          queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(skillId) }),
          queryClient.invalidateQueries({ queryKey: skillDetailKeys.relations(skillId) }),
          queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root }),
        ]);
        setRollbackTarget(undefined);
      },
      () => setCommitError(t("skillDetail.versions.rollbackError")),
    ).finally(() => {
      commitGuardRef.current = false;
      setCommitPending(false);
    });
  };

  if (versionsQuery.isPending) return <p role="status">{t("skillDetail.versions.loading")}</p>;
  if (versionsQuery.isError) return <p role="alert">{t("skillDetail.versions.loadError")}</p>;

  return (
    <div className="sh-version-timeline">
      {summary ? <VersionUpdateNotice summary={summary} /> : null}
      <ol>
        {versionsQuery.data.map((version, index) => (
          <li key={version.id}>
            <div className="sh-version-timeline__node" />
            <article>
              <div className="sh-version-timeline__heading">
                <h3>{version.label}</h3>
                {index === 0 ? <StatusBadge tone="info">{t("skillDetail.versions.current")}</StatusBadge> : null}
              </div>
              <p>{version.createdAt} · {t(`skillDetail.versions.origin.${version.origin}`)}</p>
              <p>{t("skillDetail.versions.changes", version.changes)}</p>
              <label>
                <input
                  aria-label={t("skillDetail.versions.selectCompare", { version: version.label })}
                  checked={selected.includes(version.id)}
                  onChange={() => {
                    setCompareRequested(false);
                    setSelected((current) => toggleComparedVersion(current, version.id));
                  }}
                  type="checkbox"
                />
                {t("skillDetail.versions.compare")}
              </label>
              {index > 0 ? (
                <Button onClick={() => prepareRollback(version.id)} size="sm" variant="ghost">
                  {t("skillDetail.versions.rollbackTo", { version: version.label })}
                </Button>
              ) : null}
            </article>
          </li>
        ))}
      </ol>
      <Button disabled={selected.length !== 2} onClick={() => setCompareRequested(true)} size="sm" variant="secondary">
        {t("skillDetail.versions.compareSelected")}
      </Button>
      {diffQuery.data ? (
        <div className="sh-version-timeline__diff" role="region" aria-label={t("skillDetail.versions.fileDetails.label")}>
          <p>{t("skillDetail.versions.added", { count: diffQuery.data.added.length })}</p>
          <p>{t("skillDetail.versions.changed", { count: diffQuery.data.changed.length })}</p>
          <p>{t("skillDetail.versions.removed", { count: diffQuery.data.removed.length })}</p>
          {(["added", "changed", "removed"] as const).map((kind) => (
            <section className="sh-version-timeline__file-group" key={kind}>
              <h4>{t(`skillDetail.versions.fileDetails.${kind}`)}</h4>
              {diffQuery.data[kind].length > 0 ? (
                <ul>
                  {diffQuery.data[kind].map((path) => <li key={path}><code>{path}</code></li>)}
                </ul>
              ) : <p>{t("skillDetail.versions.fileDetails.empty")}</p>}
            </section>
          ))}
        </div>
      ) : null}
      {rollbackTarget ? (
        <section className="sh-version-timeline__rollback">
          <h3 ref={previewHeadingRef} tabIndex={-1}>{t("skillDetail.versions.rollbackPreview")}</h3>
          {impactQuery.isPending ? <p role="status">{t("skillDetail.versions.impactLoading")}</p> : null}
          {impactQuery.data ? (
            <>
              <p>{t("skillDetail.versions.createsVersion")}</p>
              <ul>
                {impactQuery.data.deployments.map((deployment) => (
                  <li key={deployment.id}>
                    {deployment.affected
                      ? t("skillDetail.versions.deploymentUpdates", { label: deployment.label })
                      : t("skillDetail.versions.pinnedUnaffected", { label: deployment.label })}
                  </li>
                ))}
              </ul>
              <p>{t("skillDetail.versions.rerunBasic")}</p>
              <Button disabled={commitPending} loading={commitPending} onClick={commitRollback} size="sm">
                {t("skillDetail.versions.confirmRollback")}
              </Button>
              <Button disabled={commitPending} onClick={() => setRollbackTarget(undefined)} size="sm" variant="ghost">
                {t("actions.cancel")}
              </Button>
            </>
          ) : null}
          {commitError ? <p role="alert">{commitError}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
