import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DEFAULT_SKILL_QUERY } from "./api";
import type { SkillLibraryFacade, SkillTableRow } from "./api";
import { CombinationPanel } from "./CombinationPanel";

/**
 * AR-022 组合管理子页：把组合的全部能力（列表、创建、成员维护、删除、
 * 导出）从技能库主页挪到独立路由，避免挤压日常 Skill 明细视图。
 * 技能库名称映射来自真实分页查询，用于把成员 ID 呈现为显示名。
 */
export function CombinationManagerPage({ facade }: { facade: SkillLibraryFacade }) {
  const { t } = useTranslation();
  const [skillNames, setSkillNames] = useState<Record<string, string>>({});
  const [namesUnavailable, setNamesUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    facade
      .listSkills({ ...DEFAULT_SKILL_QUERY, page: 1, pageSize: 100 })
      .then((page) => {
        if (cancelled) return;
        const names: Record<string, string> = {};
        for (const item of page.items as SkillTableRow[]) {
          names[item.id] = item.name;
        }
        setSkillNames(names);
      })
      .catch(() => {
        if (!cancelled) setNamesUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [facade]);

  return (
    <main className="sh-page sh-workflow-page">
      <header className="sh-page__header">
        <div>
          <p className="sh-eyebrow">{t("skillLibrary.combinations.managerEyebrow")}</p>
          <h1>{t("skillLibrary.combinations.managerHeading")}</h1>
          <p>{t("skillLibrary.combinations.managerDescription")}</p>
        </div>
        <Link className="sh-button sh-button--secondary sh-button--md" to="/library">
          {t("skillLibrary.combinations.managerBack")}
        </Link>
      </header>
      {namesUnavailable ? (
        <p role="alert">{t("skillLibrary.combinations.memberNamesUnavailable")}</p>
      ) : null}
      {facade.listCombinations ? (
        <section className="sh-workflow-card">
          <CombinationPanel facade={facade} skillNames={skillNames} />
        </section>
      ) : null}
    </main>
  );
}
