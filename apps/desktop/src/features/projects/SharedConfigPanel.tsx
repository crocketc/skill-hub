import { useTranslation } from "react-i18next";
import type { ProjectSharedConfig } from "./api";

export interface SharedConfigPanelProps {
  config: ProjectSharedConfig;
}

export function SharedConfigPanel({ config }: SharedConfigPanelProps) {
  const { t } = useTranslation();
  return (
    <section className="sh-project-detail__panel" aria-labelledby="shared-config-title">
      <div className="sh-project-section-heading"><div><p className="sh-project-eyebrow">{t("projects.sharedConfig.eyebrow")}</p><h2 id="shared-config-title">{t("projects.sharedConfig.title")}</h2></div><span>{t("projects.readOnly")}</span></div>
      <dl className="sh-project-detail__facts">
        <div><dt>{t("projects.sharedConfig.identity")}</dt><dd>{config.identityHint}</dd></div>
        <div><dt>{t("projects.sharedConfig.targets")}</dt><dd>{config.targetIds.join(" · ")}</dd></div>
      </dl>
      <div><strong>{t("projects.sharedConfig.requirements")}</strong><ul>{config.requirements.map((requirement) => <li key={requirement}>{requirement}</li>)}</ul></div>
    </section>
  );
}
