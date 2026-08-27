import type { BootstrapSnapshot } from "../../api/bindings";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import { getPendingSummaryItems } from "./api";

interface PendingSummaryProps {
  snapshot: BootstrapSnapshot;
}

export function PendingSummary({ snapshot }: PendingSummaryProps) {
  const { t } = useTranslation();
  const items = getPendingSummaryItems(snapshot, t);

  return (
    <section className="sh-overview__pending" aria-labelledby="overview-pending-title">
      <div className="sh-overview__section-head">
        <div>
          <p className="sh-overview__eyebrow">{t("overview.pending.eyebrow")}</p>
          <h2 id="overview-pending-title">
            {snapshot.pending.total > 0
              ? t("overview.pending.title", { count: snapshot.pending.total })
              : t("overview.pending.none")}
          </h2>
        </div>
        <StatusBadge tone={snapshot.pending.total > 0 ? "warning" : "info"}>
          {snapshot.pending.total > 0
            ? t("overview.pending.badge", { count: snapshot.pending.total })
            : t("overview.pending.clear")}
        </StatusBadge>
      </div>
      {items.length > 0 ? (
        <ul className="sh-overview__pending-list">
          {items.map((item) => (
            <li key={item.key} className="sh-overview__pending-item">
              <span>{item.label}</span>
              <strong>{item.count}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sh-overview__pending-empty">{t("overview.pending.emptyDescription")}</p>
      )}
    </section>
  );
}
