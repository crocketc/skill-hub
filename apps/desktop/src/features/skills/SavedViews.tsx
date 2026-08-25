import { useTranslation } from "react-i18next";
import type { SavedSkillView } from "./api";

export interface SavedViewsProps {
  activeViewId?: string;
  dirty: boolean;
  onApply: (view: SavedSkillView) => void;
  onSave: () => void;
  views: SavedSkillView[];
}

function ViewButton({ activeViewId, onApply, view }: Pick<SavedViewsProps, "activeViewId" | "onApply"> & { view: SavedSkillView }) {
  const { t } = useTranslation();
  const label = view.builtIn
    ? t(view.name as "skillLibrary.savedViews.builtIn.all")
    : view.name;

  return (
    <button aria-pressed={view.id === activeViewId} onClick={() => onApply(view)} type="button">
      {label}
    </button>
  );
}

export function SavedViews({ activeViewId, dirty, onApply, onSave, views }: SavedViewsProps) {
  const { t } = useTranslation();
  const builtInViews = views.filter((view) => view.builtIn);
  const userViews = views.filter((view) => !view.builtIn);
  const visibleViews = [...builtInViews, ...userViews.slice(0, 4)];
  const moreViews = userViews.slice(4);

  return (
    <section aria-label={t("skillLibrary.savedViews.more")}>
      {dirty && <p role="status">{t("skillLibrary.savedViews.unsaved")}</p>}
      <div>
        {visibleViews.map((view) => (
          <ViewButton activeViewId={activeViewId} key={view.id} onApply={onApply} view={view} />
        ))}
      </div>
      {moreViews.length > 0 && (
        <details aria-label={t("skillLibrary.savedViews.more")}>
          <summary>{t("skillLibrary.savedViews.more")}</summary>
          {moreViews.map((view) => (
            <ViewButton activeViewId={activeViewId} key={view.id} onApply={onApply} view={view} />
          ))}
        </details>
      )}
      <button onClick={onSave} type="button">{t("skillLibrary.savedViews.save")}</button>
    </section>
  );
}
