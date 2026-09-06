import { useTranslation } from "react-i18next";
import type { SourceUpdateCheckReport } from "./api";

/** N8：批量来源更新检查结果汇总。按已是最新 / 可升级 / 来源不可用三组
 * 展示；空组不渲染。升级的逐 Skill 应用仍在详情页显式确认，这里不做
 * 一键批量升级，避免覆盖本地修改的静默风险。 */
export function SourceUpdateCheckSummary({
  reports,
}: {
  reports: SourceUpdateCheckReport[];
}): JSX.Element {
  const { t } = useTranslation();
  const upToDate = reports.filter((item) => item.state === "up_to_date");
  const upgradable = reports.filter(
    (item) =>
      item.state === "update_available" ||
      item.state === "update_available_with_local_changes",
  );
  const unavailable = reports.filter((item) => item.state === "source_unavailable");
  const authRequired = reports.filter((item) => item.state === "authentication_required");

  const renderGroup = (label: string, items: SourceUpdateCheckReport[]) =>
    items.length > 0 ? (
      <fieldset key={label} className="sh-source-updates__group">
        <legend>{label}</legend>
        <ul>
          {items.map((item) => (
            <li key={item.skillId}>{item.name}</li>
          ))}
        </ul>
      </fieldset>
    ) : null;

  return (
    <section aria-live="polite" className="sh-source-updates" data-testid="source-update-checks">
      <h3>{t("skillLibrary.page.sourceUpdates.title")}</h3>
      {renderGroup(t("skillLibrary.page.sourceUpdates.upToDate", { count: upToDate.length }), upToDate)}
      {renderGroup(
        t("skillLibrary.page.sourceUpdates.upgradable", { count: upgradable.length }),
        upgradable,
      )}
      {renderGroup(
        t("skillLibrary.page.sourceUpdates.unavailable", { count: unavailable.length }),
        unavailable,
      )}
      {renderGroup(
        t("skillLibrary.page.sourceUpdates.authRequired", { count: authRequired.length }),
        authRequired,
      )}
      <p>{t("skillLibrary.page.sourceUpdates.hint")}</p>
    </section>
  );
}
