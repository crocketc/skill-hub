import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "../../ui/Input";
import { MultiSelectMenu } from "../../ui/MultiSelectMenu";
import { Select } from "../../ui/Select";
import { type CheckState, type SkillLibraryQuery, type SkillLifecycle } from "./api";

/** 高级筛选带所需的最小契约：无清除入口（清除留在检索带）。 */
export interface SkillFiltersAdvancedProps {
  availableTags: string[];
  id?: string;
  onChange: (query: SkillLibraryQuery) => void;
  query: SkillLibraryQuery;
  versionFilterSupported?: boolean;
}

export interface SkillFiltersProps {
  availableTags: string[];
  id?: string;
  onChange: (query: SkillLibraryQuery) => void;
  onClear: () => void;
  query: SkillLibraryQuery;
  /** Set to false when the production read model cannot answer the upgrade
   * filter yet; the control is disabled instead of failing the whole page. */
  versionFilterSupported?: boolean;
  /** M-21 IA 重排：受控模式。提供时组件只渲染检索行（搜索 + 筛选开关 +
   * 清除），高级筛选带由页面以 SkillFiltersAdvanced 渲染在工具栏第二
   * band；缺省时组件自管理开合并内联渲染高级筛选带（独立复用形态）。 */
  advancedOpen?: boolean;
  onAdvancedOpenChange?: (open: boolean) => void;
}

const CHECK_STATES: readonly CheckState[] = ["passed", "warning", "failed", "not_run", "unavailable"];
const LIFECYCLES: readonly SkillLifecycle[] = ["active", "trial", "archived"];
const CHECK_STATE_LABELS = {
  failed: "skillLibrary.filters.checkStates.failed",
  not_run: "skillLibrary.filters.checkStates.notRun",
  passed: "skillLibrary.filters.checkStates.passed",
  unavailable: "skillLibrary.filters.checkStates.unavailable",
  warning: "skillLibrary.filters.checkStates.warning",
} as const satisfies Record<CheckState, string>;
const LIFECYCLE_LABELS = {
  active: "skillLibrary.filters.lifecycleOptions.active",
  archived: "skillLibrary.filters.lifecycleOptions.archived",
  trial: "skillLibrary.filters.lifecycleOptions.trial",
} as const satisfies Record<SkillLifecycle, string>;
const DEPLOYMENT_OPTIONS = [
  ["any", "skillLibrary.filters.deploymentOptions.any"],
  ["deployed", "skillLibrary.filters.deploymentOptions.deployed"],
  ["not_deployed", "skillLibrary.filters.deploymentOptions.notDeployed"],
] as const;
const VERSION_OPTIONS = [
  ["any", "skillLibrary.filters.versionOptions.any"],
  ["upgrade_available", "skillLibrary.filters.versionOptions.upgradeAvailable"],
] as const;

/** 窄窗口阈值：低于该宽度时次要筛选默认折叠（搜索始终可见）。 */
const NARROW_FILTER_QUERY = "(max-width: 64rem)";

export function prefersCollapsedFilters(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(NARROW_FILTER_QUERY).matches
  );
}

/** 已生效条件数：搜索文本与每个偏离默认值的筛选维度各计 1。 */
function countActiveConditions(query: SkillLibraryQuery): number {
  let count = 0;
  if (query.text.trim().length > 0) count += 1;
  if (query.filters.basicCheck.length > 0) count += 1;
  if (query.filters.aiCheck.length > 0) count += 1;
  if (query.filters.lifecycle.length > 0) count += 1;
  if (query.filters.tags.length > 0) count += 1;
  if (query.filters.deployment !== "any") count += 1;
  if (query.filters.version !== "any") count += 1;
  return count;
}

/**
 * 高级筛选带（M-21 工具栏第二 band）：六个过滤控件统一为「标签在上、
 * 控件在下」的等高 Field 网格。裸 label 补齐与 MultiSelectMenu 的
 * `.sh-filter-dropdown` 相同的 grid 布局类——修复版本下拉悬空。
 */
export function SkillFiltersAdvanced({
  availableTags,
  id,
  onChange,
  query,
  versionFilterSupported = true,
}: SkillFiltersAdvancedProps): JSX.Element {
  const { t } = useTranslation();

  const update = (change: Partial<SkillLibraryQuery>) => {
    onChange({ ...query, ...change, page: 1, savedViewId: undefined });
  };

  const updateFilters = (filters: Partial<SkillLibraryQuery["filters"]>) => {
    update({ filters: { ...query.filters, ...filters } });
  };

  return (
    <div className="sh-skill-filters__advanced" id={`${id ?? "skill"}-filters-advanced`}>
      <MultiSelectMenu
        label={t("skillLibrary.filters.basicCheck")}
        onChange={(values) => updateFilters({ basicCheck: values as CheckState[] })}
        options={CHECK_STATES.map((state) => ({ label: t(CHECK_STATE_LABELS[state]), value: state }))}
        selected={query.filters.basicCheck}
        summary={query.filters.basicCheck.length > 0 ? t("skillLibrary.filters.selectedCount", { count: query.filters.basicCheck.length }) : t("skillLibrary.filters.any")}
      />

      <MultiSelectMenu
        label={t("skillLibrary.filters.aiCheck")}
        onChange={(values) => updateFilters({ aiCheck: values as CheckState[] })}
        options={CHECK_STATES.map((state) => ({ label: t(CHECK_STATE_LABELS[state]), value: state }))}
        selected={query.filters.aiCheck}
        summary={query.filters.aiCheck.length > 0 ? t("skillLibrary.filters.selectedCount", { count: query.filters.aiCheck.length }) : t("skillLibrary.filters.any")}
      />

      <MultiSelectMenu
        label={t("skillLibrary.filters.lifecycle")}
        onChange={(values) => updateFilters({ lifecycle: values as SkillLifecycle[] })}
        options={LIFECYCLES.map((state) => ({ label: t(LIFECYCLE_LABELS[state]), value: state }))}
        selected={query.filters.lifecycle}
        summary={query.filters.lifecycle.length > 0 ? t("skillLibrary.filters.selectedCount", { count: query.filters.lifecycle.length }) : t("skillLibrary.filters.any")}
      />

      <label className="sh-skill-filters__field">
        {t("skillLibrary.filters.deployment")}
        <Select
          onChange={(event) => updateFilters({ deployment: event.currentTarget.value as SkillLibraryQuery["filters"]["deployment"] })}
          value={query.filters.deployment}
        >
          {DEPLOYMENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </Select>
      </label>

      <label className="sh-skill-filters__field">
        {t("skillLibrary.filters.version")}
        <Select
          aria-describedby={versionFilterSupported ? undefined : `${id ?? "skill"}-version-filter-hint`}
          disabled={!versionFilterSupported}
          onChange={(event) => updateFilters({ version: event.currentTarget.value as SkillLibraryQuery["filters"]["version"] })}
          value={query.filters.version}
        >
          {VERSION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </Select>
        {versionFilterSupported ? null : (
          <p className="sh-filter-dropdown__hint" id={`${id ?? "skill"}-version-filter-hint`}>
            {t("skillLibrary.filters.versionUnavailable")}
          </p>
        )}
      </label>

      <MultiSelectMenu
        label={t("skillLibrary.filters.tags")}
        onChange={(values) => updateFilters({ tags: values })}
        options={availableTags.map((tag) => ({ label: tag, value: tag }))}
        selected={query.filters.tags}
        summary={query.filters.tags.length > 0 ? t("skillLibrary.filters.selectedCount", { count: query.filters.tags.length }) : t("skillLibrary.filters.any")}
      />
    </div>
  );
}

export function SkillFilters(props: SkillFiltersProps) {
  const {
    advancedOpen: controlledOpen,
    onAdvancedOpenChange,
    versionFilterSupported = true,
  } = props;
  const { t } = useTranslation();
  // 规格 5.3：搜索与当前生效条件常驻；次要筛选在窄窗口默认折叠。
  // M-21 IA：受控模式由页面持有开合状态（高级筛选带渲染在第二 band）。
  const [internalOpen, setInternalOpen] = useState(() => !prefersCollapsedFilters());
  const advancedOpen = controlledOpen ?? internalOpen;
  const advancedId = `${props.id ?? "skill"}-filters-advanced`;
  const activeCount = countActiveConditions(props.query);

  const update = (change: Partial<SkillLibraryQuery>) => {
    props.onChange({ ...props.query, ...change, page: 1, savedViewId: undefined });
  };

  const toggleAdvanced = () => {
    const next = !advancedOpen;
    setInternalOpen(next);
    onAdvancedOpenChange?.(next);
  };

  return (
    <section aria-label={t("skillLibrary.filters.search")} className="sh-skill-filters" id={props.id}>
      <div className="sh-skill-filters__primary">
        <label className="sh-filter-search">
          {t("skillLibrary.filters.search")}
          <Input
            name="skill-search"
            onChange={(event) => update({ text: event.currentTarget.value })}
            type="search"
            value={props.query.text}
          />
        </label>
        <button
          aria-controls={advancedId}
          aria-expanded={advancedOpen}
          className="sh-skill-library__filter-toggle"
          onClick={toggleAdvanced}
          type="button"
        >
          {t("skillLibrary.filters.advanced")}
          <span className="sh-skill-library__filter-count" data-active={activeCount > 0}>
            {t("skillLibrary.filters.activeCount", { count: activeCount })}
          </span>
        </button>
        {activeCount > 0 ? (
          <button onClick={props.onClear} type="button">
            {t("skillLibrary.filters.clear")}
          </button>
        ) : null}
      </div>

      {advancedOpen && controlledOpen === undefined ? (
        <SkillFiltersAdvanced
          availableTags={props.availableTags}
          id={props.id}
          onChange={props.onChange}
          query={props.query}
          versionFilterSupported={versionFilterSupported}
        />
      ) : null}
    </section>
  );
}
