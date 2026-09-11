import { useTranslation } from "react-i18next";
import { Select } from "../../ui/Select";
import type { SkillLibraryQuery, SkillPage } from "./api";

const PAGE_SIZES = [10, 25, 50, 100] as const;

export interface SkillPaginationProps {
  /** Extra class so the table keeps its frozen base.css layout hook. */
  className?: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: SkillLibraryQuery["pageSize"]) => void;
  page: SkillPage;
  query: SkillLibraryQuery;
}

/**
 * 分页页脚（T3-B 从 SkillTable 抽取）：卡片视图与表格视图共用同一套
 * 分页语义——每页数量、结果范围、上一页/下一页——查询语义不变。
 */
export function SkillPagination({
  className,
  onPageChange,
  onPageSizeChange,
  page,
  query,
}: SkillPaginationProps): JSX.Element {
  const { t } = useTranslation();
  const pageCount = Math.ceil(page.total / query.pageSize);
  const start = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const end = Math.min(page.page * page.pageSize, page.total);

  return (
    <footer
      className={className ? `sh-skill-pagination ${className}` : "sh-skill-pagination"}
    >
      <label>
        {t("skillLibrary.table.pageSize")}
        <Select
          aria-label={t("skillLibrary.table.pageSize")}
          onChange={(event) =>
            onPageSizeChange(Number(event.currentTarget.value) as SkillLibraryQuery["pageSize"])}
          value={query.pageSize}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </Select>
      </label>
      <span>{t("skillLibrary.table.pageRange", { end, start, total: page.total })}</span>
      <button
        className="sh-button sh-button--secondary sh-button--sm"
        disabled={query.page <= 1}
        onClick={() => onPageChange(query.page - 1)}
        type="button"
      >
        {t("skillLibrary.table.previousPage")}
      </button>
      <button
        className="sh-button sh-button--secondary sh-button--sm"
        disabled={query.page >= pageCount}
        onClick={() => onPageChange(query.page + 1)}
        type="button"
      >
        {t("skillLibrary.table.nextPage")}
      </button>
    </footer>
  );
}
