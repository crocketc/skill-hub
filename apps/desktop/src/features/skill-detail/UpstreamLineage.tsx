import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { SkillUpstreamLineage } from "../../api/bindings";
import { formatTimestamp } from "../../i18n";

export interface UpstreamLineageProps {
  /**
   * K5/MS-04：上游“复用修改”谱系。undefined/null 表示后端未登记——
   * 诚实缺省：不渲染任何区块，绝不编造来源名称或用占位块填充版面。
   */
  lineage?: SkillUpstreamLineage | null;
}

/**
 * 详情页上游谱系：来源显示名可解析时以链接语义指向来源主体；
 * 来源主体已删除（display_name 为 null）时呈现无标签形态，
 * 不渲染指向不存在主体的链接，也不裸露内部 skill/version 标识。
 */
export function UpstreamLineage({ lineage }: UpstreamLineageProps) {
  const { t, i18n } = useTranslation();
  if (!lineage) return null;
  const locale = i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en-US";
  const registeredAt = lineage.created_at
    ? formatTimestamp(lineage.created_at, locale)
    : null;
  return (
    <div className="sh-skill-detail__lineage" data-testid="upstream-lineage">
      <h4>{t("skillDetail.lineage.title")}</h4>
      <p>
        {lineage.source_display_name
          ? <Link to={`/library/${lineage.source_skill_id}`}>{lineage.source_display_name}</Link>
          : <span>{t("skillDetail.lineage.sourceRemoved")}</span>}
        {registeredAt
          ? <span className="sh-skill-detail__lineage-time">
            {t("skillDetail.lineage.registeredAt", { time: registeredAt })}
          </span>
          : null}
      </p>
    </div>
  );
}
