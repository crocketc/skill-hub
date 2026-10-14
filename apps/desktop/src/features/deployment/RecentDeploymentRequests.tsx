import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { BatchDeploymentFacade, RecentDeploymentPreviewRequest } from "./api";

type LoadState = "unavailable" | "loading" | "ready" | "error";

export function useRecentDeploymentRequests(facade: BatchDeploymentFacade) {
  const [requests, setRequests] = useState<RecentDeploymentPreviewRequest[]>([]);
  const [state, setState] = useState<LoadState>(facade.listRecentPreviewRequests ? "loading" : "unavailable");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    if (!facade.listRecentPreviewRequests) {
      setState("unavailable");
      setRequests([]);
      return () => { active = false; };
    }
    setState("loading");
    void facade.listRecentPreviewRequests().then((value) => {
      if (!active) return;
      setRequests(value);
      setState("ready");
    }).catch(() => {
      if (!active) return;
      setRequests([]);
      setState("error");
    });
    return () => { active = false; };
  }, [attempt, facade]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { requests, state, retry };
}

function formatCreatedAt(value: string, unknownLabel: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return unknownLabel;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

type Props = {
  requests: RecentDeploymentPreviewRequest[];
  state: LoadState;
  onRetry: () => void;
  onRecheck: (request: RecentDeploymentPreviewRequest) => void;
};

export function RecentDeploymentRequests({ requests, state, onRetry, onRecheck }: Props) {
  const { t } = useTranslation();
  if (state === "unavailable") return null;

  return (
    <section aria-labelledby="deployment-recent-requests-heading" className="sh-deployment-flow__section sh-deployment-recent-requests">
      <div className="sh-section-heading">
        <div>
          <h2 id="deployment-recent-requests-heading">{t("deployment.recent.heading")}</h2>
          <p>{t("deployment.recent.description")}</p>
        </div>
      </div>
      {state === "loading" ? <p aria-live="polite" role="status">{t("deployment.recent.loading")}</p> : null}
      {state === "error" ? (
        <div className="sh-deployment-recent-requests__error" role="alert">
          <span>{t("deployment.recent.error")}</span>
          <Button onClick={onRetry} size="sm" variant="secondary">{t("deployment.recent.retry")}</Button>
        </div>
      ) : null}
      {state === "ready" && requests.length === 0 ? <p role="status">{t("deployment.recent.empty")}</p> : null}
      {state === "ready" && requests.length > 0 ? (
        <ul aria-label={t("deployment.recent.heading")} className="sh-deployment-recent-requests__list">
          {requests.map((request) => {
            const skillCount = new Set(request.items.map((item) => item.skillId)).size;
            const targetCount = new Set(request.items.flatMap((item) => item.targetIds)).size;
            return (
              <li className="sh-deployment-recent-requests__item" key={request.previewId}>
                <div>
                  <strong>{formatCreatedAt(request.createdAt, String(t("deployment.recent.unknownTime")))}</strong>
                  <small>{t("deployment.recent.summary", { skills: skillCount, targets: targetCount })}</small>
                </div>
                <Button onClick={() => onRecheck(request)} size="sm" variant="secondary">
                  {t("deployment.recent.recheck")}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
