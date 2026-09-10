import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  /**
   * The top bar owns the route-level `h1`; page content starts at `h2`
   * (default). Standalone detail pages without a top bar may use `h1`.
   */
  headingLevel?: "h1" | "h2";
}

export function PageHeader({
  description,
  headingLevel = "h2",
  title,
  actions,
}: PageHeaderProps) {
  const Title = headingLevel;

  return (
    <header className="sh-page-header">
      <div className="sh-page-header__text">
        <Title className="sh-page-header__title">{title}</Title>
        {description ? (
          <p className="sh-page-header__description">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="sh-page-header__actions">{actions}</div> : null}
    </header>
  );
}
