import type { BootstrapSnapshot } from "../../api/bindings";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
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
            <li key={item.key}>
              {/* P1-07：待办项升级为通往 /pending 工作台的链接，保留原有
                  列表项结构与可访问名称；零待办空态保持纯文本。 */}
              <Link className="sh-overview__pending-item" to="/pending">
                <span>{item.label}</span>
                {/* 数量已包含在 label 文案中，视觉加强的数字对读屏冗余，
                    标记为装饰以保持链接可访问名称为完整句子。 */}
                <strong aria-hidden="true">{item.count}</strong>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sh-overview__pending-empty">{t("overview.pending.emptyDescription")}</p>
      )}
    </section>
  );
}
