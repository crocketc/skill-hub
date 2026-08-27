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

function selectedValues(event: React.ChangeEvent<HTMLSelectElement>): string[] {
  return Array.from(event.currentTarget.selectedOptions, (option) => option.value);
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
      <label>
        {t("skillLibrary.filters.search")}
        <input
          name="skill-search"
          onChange={(event) => update({ text: event.currentTarget.value })}
          type="search"
          value={query.text}
        />
      </label>

      <fieldset>
        <legend>{t("skillLibrary.filters.basicCheck")}</legend>
        <select
          aria-label={t("skillLibrary.filters.basicCheck")}
          multiple
          onChange={(event) => updateFilters({ basicCheck: selectedValues(event) as CheckState[] })}
          value={query.filters.basicCheck}
        >
          {CHECK_STATES.map((state) => <option key={state} value={state}>{t(CHECK_STATE_LABELS[state])}</option>)}
        </select>
      </fieldset>

      <fieldset>
        <legend>{t("skillLibrary.filters.aiCheck")}</legend>
        <select
          aria-label={t("skillLibrary.filters.aiCheck")}
          multiple
          onChange={(event) => updateFilters({ aiCheck: selectedValues(event) as CheckState[] })}
          value={query.filters.aiCheck}
        >
          {CHECK_STATES.map((state) => <option key={state} value={state}>{t(CHECK_STATE_LABELS[state])}</option>)}
        </select>
      </fieldset>

      <fieldset>
        <legend>{t("skillLibrary.filters.lifecycle")}</legend>
        <select
          aria-label={t("skillLibrary.filters.lifecycle")}
          multiple
          onChange={(event) => updateFilters({ lifecycle: selectedValues(event) as SkillLifecycle[] })}
          value={query.filters.lifecycle}
        >
          {LIFECYCLES.map((state) => <option key={state} value={state}>{t(LIFECYCLE_LABELS[state])}</option>)}
        </select>
      </fieldset>

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

      <fieldset>
        <legend>{t("skillLibrary.filters.tags")}</legend>
        <select
          aria-label={t("skillLibrary.filters.tags")}
          multiple
          onChange={(event) => updateFilters({ tags: selectedValues(event) })}
          value={query.filters.tags}
        >
          {availableTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
      </fieldset>

      <p>{t("skillLibrary.filters.resultCount", { count: resultCount })}</p>
      <button onClick={onClear} type="button">{t("skillLibrary.filters.clear")}</button>
    </section>
  );
}
