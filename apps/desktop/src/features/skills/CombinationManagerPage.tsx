import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DEFAULT_SKILL_QUERY } from "./api";
import type { SkillLibraryFacade, SkillTableRow } from "./api";
import { CombinationPanel } from "./CombinationPanel";

/** 名称映射分页大小与硬上限：逐页取全，超出第一页的成员也能拿到显示名。 */
const NAME_PAGE_SIZE = 100;
const NAME_MAX_PAGES = 50;

/**
 * P1-09：按页取全技能名称映射（id → 显示名），不再只取第一页 100 条；
 * 上限防御异常 total，超出上限时诚实按已取到的部分渲染。
 */
export async function collectSkillNames(
  facade: SkillLibraryFacade,
): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  for (let page = 1; page <= NAME_MAX_PAGES; page += 1) {
    const result = await facade.listSkills({
      ...DEFAULT_SKILL_QUERY,
      page,
      pageSize: NAME_PAGE_SIZE,
    });
    for (const item of result.items as SkillTableRow[]) {
      names[item.id] = item.name;
    }
    if (result.items.length === 0 || Object.keys(names).length >= result.total) break;
  }
  return names;
}

/**
 * AR-022 组合管理子页：把组合的全部能力（列表、创建、成员维护、重命名、
 * 删除、导出）从技能库主页挪到独立路由，避免挤压日常 Skill 明细视图。
 * 技能库名称映射来自真实分页查询，用于把成员 ID 呈现为显示名。
 */
export function CombinationManagerPage({ facade }: { facade: SkillLibraryFacade }) {
  const { t } = useTranslation();
  const [skillNames, setSkillNames] = useState<Record<string, string>>({});
  const [namesUnavailable, setNamesUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    collectSkillNames(facade)
      .then((names) => {
        if (!cancelled) setSkillNames(names);
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
