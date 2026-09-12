import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  // 第一页拿到 total 与实际每页条数后，其余页并行拉取，避免逐页串行等待。
  // 页数按首页实际返回条数估算：首页不足一页即说明已取全（total 覆盖）。
  const first = await facade.listSkills({
    ...DEFAULT_SKILL_QUERY,
    page: 1,
    pageSize: NAME_PAGE_SIZE,
  });
  for (const item of first.items as SkillTableRow[]) {
    names[item.id] = item.name;
  }
  if (first.items.length === 0) return names;
  const effectivePageSize = Math.max(1, first.items.length);
  const totalPages = Math.min(
    NAME_MAX_PAGES,
    Math.ceil(first.total / effectivePageSize),
  );
  if (totalPages <= 1) return names;
  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) =>
      facade.listSkills({
        ...DEFAULT_SKILL_QUERY,
        page: index + 2,
        pageSize: NAME_PAGE_SIZE,
      })),
  );
  for (const result of rest) {
    for (const item of result.items as SkillTableRow[]) {
      names[item.id] = item.name;
    }
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
