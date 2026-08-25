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
          {CHECK_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
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
          {CHECK_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
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
          {LIFECYCLES.map((state) => <option key={state} value={state}>{state}</option>)}
        </select>
      </fieldset>

      <label>
        {t("skillLibrary.filters.deployment")}
        <select
          onChange={(event) => updateFilters({ deployment: event.currentTarget.value as SkillLibraryQuery["filters"]["deployment"] })}
          value={query.filters.deployment}
        >
          <option value="any">any</option>
          <option value="deployed">deployed</option>
          <option value="not_deployed">not deployed</option>
        </select>
      </label>

      <label>
        {t("skillLibrary.filters.version")}
        <select
          onChange={(event) => updateFilters({ version: event.currentTarget.value as SkillLibraryQuery["filters"]["version"] })}
          value={query.filters.version}
        >
          <option value="any">any</option>
          <option value="upgrade_available">upgrade available</option>
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
