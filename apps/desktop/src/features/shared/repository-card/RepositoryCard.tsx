import type { ReactNode } from "react";
import type { RepositoryCardViewModel } from "./RepositoryCardViewModel";
import "./repository-card.css";

export interface RepositoryCardProps {
  repository: RepositoryCardViewModel;
  sourceAction?: ReactNode;
  statusControl?: ReactNode;
  actions?: ReactNode;
  headingLevel?: "h2" | "h3" | "h4";
}

export function RepositoryCard({
  actions,
  headingLevel: Heading = "h3",
  repository,
  sourceAction,
  statusControl,
}: RepositoryCardProps) {
  return (
    <article
      aria-label={repository.coordinates}
      className={`sh-repository-card${repository.enabled ? "" : " sh-repository-card--disabled"}`}
      data-repository-card={repository.id}
      data-testid="repository-card"
    >
      <header className="sh-repository-card__header">
        <div className="sh-repository-card__identity">
          <Heading className="sh-repository-card__title">{repository.coordinates}</Heading>
          <div className="sh-repository-card__source">
            <span>{repository.sourceLabel}</span>
            {sourceAction}
          </div>
          <span className="sh-repository-card__branch">
            <span className="sh-repository-card__branch-label">{repository.branchLabel}</span>
            <span>{repository.branch}</span>
          </span>
        </div>
        <div className="sh-repository-card__status">
          <span
            className={`sh-repository-card__status-label sh-repository-card__status-label--${repository.enabled ? "enabled" : "disabled"}`}
          >
            {repository.enabledLabel}
          </span>
          {statusControl}
        </div>
      </header>

      <dl className={`sh-repository-card__scan sh-repository-card__scan--${repository.scan.tone}`}>
        <dt>{repository.scan.label}</dt>
        <dd>
          <span>{repository.scan.value}</span>
          {repository.scan.detail ? <span>{repository.scan.detail}</span> : null}
        </dd>
      </dl>

      {actions ? <div className="sh-repository-card__actions">{actions}</div> : null}
    </article>
  );
}
