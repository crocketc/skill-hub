import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { type PendingFacade, type PendingItem, unavailablePendingFacade } from "./api";

export function PendingPage({ facade = unavailablePendingFacade }: { facade?: PendingFacade }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<PendingItem[]>();
  const [error, setError] = useState<string>();
  const reload = () => void facade.list().then(setItems).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  useEffect(reload, [facade]);
  if (error) return <DataState message={error} state="unavailable" />;
  if (!items) return <DataState message={t("pending.loading")} state="loading" />;
  if (!items.length) return <DataState message={t("pending.empty")} state="empty" />;
  const run = async (item: PendingItem, action: keyof PendingFacade) => {
    if (action === "list") return;
    await facade[action](item);
    reload();
  };
  return <main className="sh-page sh-workflow-page"><header className="sh-page__header"><div><p className="sh-eyebrow">{t("pending.eyebrow")}</p><h1>{t("pending.heading")}</h1><p>{t("pending.description")}</p></div></header><section className="sh-workflow-card" aria-labelledby="pending-list-heading"><h2 id="pending-list-heading">{t("pending.listHeading")}</h2><ul className="sh-workflow-list">{items.map((item) => <li className="sh-workflow-list__item" key={item.id}><div><strong>{item.subject}</strong><p>{t(item.message, { defaultValue: item.code })}</p></div><div className="sh-workflow-actions">{item.kind === "recovery" ? <Button onClick={() => void run(item, "recover")} size="sm">{t("pending.actions.recover")}</Button> : null}{item.kind === "security_finding" ? <Button onClick={() => void run(item, "recheck")} size="sm" variant="secondary">{t("pending.actions.recheck")}</Button> : null}{item.kind === "trial_due" ? <Button onClick={() => void run(item, "convert")} size="sm" variant="secondary">{t("pending.actions.convert")}</Button> : null}<Button onClick={() => void run(item, "resolve")} size="sm" variant="ghost">{t("pending.actions.resolve")}</Button></div></li>)}</ul></section></main>;
}
