import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type CheckState, type SkillLibraryQuery, type SkillLifecycle } from "./api";

export interface SkillFiltersProps {
  availableTags: string[];
  onChange: (query: SkillLibraryQuery) => void;
  onClear: () => void;
  query: SkillLibraryQuery;
  resultCount: number;
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

interface MultiSelectMenuProps {
  label: string;
  onChange: (values: string[]) => void;
  options: Array<{ label: string; value: string }>;
  selected: string[];
}

function MultiSelectMenu({ label, onChange, options, selected }: MultiSelectMenuProps) {
  const [open, setOpen] = useState(false);
  const summary = selected.length > 0 ? `${label} (${selected.length})` : label;
  const toggle = (value: string, checked: boolean) => {
    onChange(checked ? [...selected, value] : selected.filter((item) => item !== value));
  };

  return (
    <div className="sh-filter-dropdown">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="sh-filter-dropdown__trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{summary}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div aria-label={label} className="sh-filter-dropdown__menu" role="menu">
          {options.map((option) => (
            <label key={option.value}>
              <input
                aria-checked={selected.includes(option.value)}
                aria-label={option.label}
                checked={selected.includes(option.value)}
                onChange={(event) => toggle(option.value, event.currentTarget.checked)}
                role="menuitemcheckbox"
                type="checkbox"
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SkillFilters({ availableTags, onChange, onClear, query, resultCount }: SkillFiltersProps) {
  const { t } = useTranslation();

  const update = (change: Partial<SkillLibraryQuery>) => {
    onChange({ ...query, ...change, page: 1, savedViewId: undefined });
  };

  const updateFilters = (filters: Partial<SkillLibraryQuery["filters"]>) => {
    update({ filters: { ...query.filters, ...filters } });
  };

  return (
    <section aria-label={t("skillLibrary.filters.search")}>
      <label className="sh-filter-search">
        {t("skillLibrary.filters.search")}
        <input
          name="skill-search"
          onChange={(event) => update({ text: event.currentTarget.value })}
          type="search"
          value={query.text}
        />
      </label>

      <MultiSelectMenu
        label={t("skillLibrary.filters.basicCheck")}
        onChange={(values) => updateFilters({ basicCheck: values as CheckState[] })}
        options={CHECK_STATES.map((state) => ({ label: t(CHECK_STATE_LABELS[state]), value: state }))}
        selected={query.filters.basicCheck}
      />

      <MultiSelectMenu
        label={t("skillLibrary.filters.aiCheck")}
        onChange={(values) => updateFilters({ aiCheck: values as CheckState[] })}
        options={CHECK_STATES.map((state) => ({ label: t(CHECK_STATE_LABELS[state]), value: state }))}
        selected={query.filters.aiCheck}
      />

      <MultiSelectMenu
        label={t("skillLibrary.filters.lifecycle")}
        onChange={(values) => updateFilters({ lifecycle: values as SkillLifecycle[] })}
        options={LIFECYCLES.map((state) => ({ label: t(LIFECYCLE_LABELS[state]), value: state }))}
        selected={query.filters.lifecycle}
      />

      <label>
        {t("skillLibrary.filters.deployment")}
        <select
          onChange={(event) => updateFilters({ deployment: event.currentTarget.value as SkillLibraryQuery["filters"]["deployment"] })}
          value={query.filters.deployment}
        >
          {DEPLOYMENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </label>

      <label>
        {t("skillLibrary.filters.version")}
        <select
          onChange={(event) => updateFilters({ version: event.currentTarget.value as SkillLibraryQuery["filters"]["version"] })}
          value={query.filters.version}
        >
          {VERSION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </label>

      <MultiSelectMenu
        label={t("skillLibrary.filters.tags")}
        onChange={(values) => updateFilters({ tags: values })}
        options={availableTags.map((tag) => ({ label: tag, value: tag }))}
        selected={query.filters.tags}
      />

      <p>{t("skillLibrary.filters.resultCount", { count: resultCount })}</p>
      <button onClick={onClear} type="button">{t("skillLibrary.filters.clear")}</button>
    </section>
  );
}
