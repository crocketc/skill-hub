import type { BootstrapSnapshot } from "../../api/bindings";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { StatusBadge } from "../../ui/StatusBadge";
import { getPendingSummaryItems } from "./api";
import type { PendingFacade, PendingKind } from "../pending/api";
import { usePendingItems } from "../pending/usePendingItems";
import { Button } from "../../ui/Button";

interface PendingSummaryProps {
  snapshot: BootstrapSnapshot;
  facade?: Pick<PendingFacade, "list">;
}

export function PendingSummary({ snapshot, facade }: PendingSummaryProps) {
  const { t } = useTranslation();
  const pending = usePendingItems(facade);
  const kinds: PendingKind[] = ["recovery", "conflict", "governance", "security_finding", "trial_due"];
  const items = facade ? kinds.flatMap((key) => {
    const count = pending.items?.filter((item) => item.kind === key).length ?? 0;
    return count ? [{ key, count, label: t(`overview.pending.kinds.${key}`, { count }) }] : [];
  }) : getPendingSummaryItems(snapshot, t);
  const total = facade ? pending.items?.length ?? 0 : snapshot.pending.total;
  if (facade && (pending.error || !pending.items)) return <section className="sh-overview__pending">
    <h2>{t("overview.pending.eyebrow")}</h2>
    <p role={pending.error ? "alert" : "status"}>{pending.error ? t("pending.loadFailed") : t("pending.loading")}</p>
    {pending.error ? <Button onClick={pending.reload}>{t("pending.actions.refresh")}</Button> : null}
  </section>;

  return (
    <section className="sh-overview__pending" aria-labelledby="overview-pending-title">
      <div className="sh-overview__section-head">
        <div>
          <p className="sh-overview__eyebrow">{t("overview.pending.eyebrow")}</p>
          <h2 id="overview-pending-title">
            {total > 0
              ? t("overview.pending.title", { count: total })
              : t("overview.pending.none")}
          </h2>
        </div>
        <StatusBadge tone={total > 0 ? "warning" : "info"}>
          {total > 0
            ? t("overview.pending.badge", { count: total })
            : t("overview.pending.clear")}
        </StatusBadge>
      </div>
      {items.length > 0 ? (
        <ul className="sh-overview__pending-list">
          {items.map((item) => (
            <li key={item.key}>
              {/* P1-07：待办项升级为通往 /pending 工作台的链接，保留原有
                  列表项结构与可访问名称；零待办空态保持纯文本。 */}
              <Link className="sh-overview__pending-item" to={facade ? `/pending?kind=${item.key}` : "/pending"}>
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
