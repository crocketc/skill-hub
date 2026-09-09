import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeploymentRecord } from "../../api/bindings";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";

export interface ProjectManagedDeploymentsOps {
  list: () => Promise<DeploymentRecord[]>;
  detach: (deploymentId: string) => Promise<unknown>;
}

interface ProjectManagedDeploymentsProps {
  ops: ProjectManagedDeploymentsOps;
  projectId: string;
}

/**
 * 项目详情"解除管理"落点：列出本项目目录下受管（managed=1）的 Skill 副本，
 * 经确认后调用既有 `detach_management` 契约。文件保留在原位，仅停止跟踪。
 */
export function ProjectManagedDeployments({ ops, projectId }: ProjectManagedDeploymentsProps): JSX.Element {
  const { t } = useTranslation();
  const [records, setRecords] = useState<DeploymentRecord[]>();
  const [failed, setFailed] = useState(false);
  const [confirmingFor, setConfirmingFor] = useState<DeploymentRecord>();
  const [detached, setDetached] = useState<string>();
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    let active = true;
    ops.list()
      .then((value) => {
        if (!active) return;
        setRecords(value);
        setFailed(false);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [ops]);

  useEffect(() => reload(), [reload]);

  const managed = (records ?? []).filter(
    (record) => record.managed && record.target_id === projectId && record.state !== "removed",
  );

  const detach = (record: DeploymentRecord) => {
    setError(undefined);
    setDetached(undefined);
    ops.detach(record.id)
      .then(() => {
        setDetached(record.skill_id);
        setConfirmingFor(undefined);
        reload();
      })
      .catch((reason: unknown) => {
        setConfirmingFor(undefined);
        setError(describeNativeError(
          reason,
          (key, options) => String(t(key as never, options as never)),
          "projects.detail.managedDeployments.failed",
        ));
      });
  };

  return (
    <section aria-labelledby="project-managed-deployments" className="sh-project-detail__panel">
      <div className="sh-project-section-heading">
        <div>
          <p className="sh-project-eyebrow">{t("projects.detail.managedDeployments.eyebrow")}</p>
          <h2 id="project-managed-deployments">{t("projects.detail.managedDeployments.title")}</h2>
        </div>
      </div>
      <p>{t("projects.detail.managedDeployments.description")}</p>
      {failed ? <p role="alert">{t("projects.detail.managedDeployments.unavailable")}</p> : null}
      {!failed && records === undefined ? (
        <DataState message={t("projects.loading")} state="loading" />
      ) : null}
      {!failed && records !== undefined && managed.length === 0 && !detached ? (
        <p>{t("projects.detail.managedDeployments.empty")}</p>
      ) : null}
      {managed.length > 0 ? (
        <ul className="sh-workflow-list">
          {managed.map((record) => (
            <li className="sh-workflow-list__item" key={record.id}>
              <span>
                <strong>{record.skill_id}</strong>
                <small>{record.runtime_name}</small>
              </span>
              {confirmingFor?.id === record.id ? (
                <span className="sh-workflow-actions">
                  <small role="status">
                    {t("projects.detail.managedDeployments.confirmBody", {
                      skill: record.skill_id,
                      path: record.target_id,
                    })}
                  </small>
                  <Button size="sm" variant="danger" onClick={() => detach(record)}>
                    {t("projects.detail.managedDeployments.confirm")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setConfirmingFor(undefined)}
                  >
                    {t("projects.detail.managedDeployments.cancel")}
                  </Button>
                </span>
              ) : (
                <Button size="sm" onClick={() => { setError(undefined); setDetached(undefined); setConfirmingFor(record); }}>
                  {t("projects.detail.managedDeployments.detach")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {detached ? (
        <p aria-live="polite" role="status">
          {t("projects.detail.managedDeployments.detached", { skill: detached })}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
