import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { SkillDetailSummary } from "./api";

interface VersionUpdateNoticeProps {
  compact?: boolean;
  summary: SkillDetailSummary;
}

export function VersionUpdateNotice({ compact = false, summary }: VersionUpdateNoticeProps) {
  const { t } = useTranslation();
  if (!summary.upgradeAvailable) return null;

  return (
    <section
      aria-label={t("skillDetail.versions.updateAvailableTitle")}
      className={`sh-version-update${compact ? " sh-version-update--compact" : ""}`}
    >
      <div>
        <h3>{t("skillDetail.versions.updateAvailableTitle")}</h3>
        <p>
          {t("skillDetail.versions.updateVersion", {
            current: summary.currentVersion,
            upstream: summary.upstreamVersion ?? t("skillDetail.versions.upstreamPending"),
          })}
        </p>
      </div>
      <Button disabled size="sm" variant="secondary">
        {t("skillDetail.versions.viewUpdateDiff")}
      </Button>
      <p className="sh-version-update__note">
        {t("skillDetail.versions.updateUnavailable")}
      </p>
    </section>
  );
}
