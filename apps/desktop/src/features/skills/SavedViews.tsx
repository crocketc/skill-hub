import { useTranslation } from "react-i18next";
import type { SavedSkillView } from "./api";

export interface SavedViewsProps {
  activeViewId?: string;
  dirty: boolean;
  onApply: (view: SavedSkillView) => void;
  onDelete?: (view: SavedSkillView) => void;
  onSave: () => void;
  views: SavedSkillView[];
}

function ViewButton({ activeViewId, onApply, onDelete, view }: Pick<SavedViewsProps, "activeViewId" | "onApply" | "onDelete"> & { view: SavedSkillView }) {
  const { t } = useTranslation();
  const label = view.builtIn
    ? t(view.name as "skillLibrary.savedViews.builtIn.all")
    : view.name;

  return (
    <span className="sh-saved-view">
      <button aria-pressed={view.id === activeViewId} onClick={() => onApply(view)} type="button">
        {label}
      </button>
      {!view.builtIn && onDelete ? (
        <button
          aria-label={t("skillLibrary.savedViews.delete", { name: label })}
          className="sh-saved-view__delete"
          onClick={() => onDelete(view)}
          type="button"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

export function SavedViews({ activeViewId, dirty, onApply, onDelete, onSave, views }: SavedViewsProps) {
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
          <ViewButton activeViewId={activeViewId} key={view.id} onApply={onApply} onDelete={onDelete} view={view} />
        ))}
      </div>
      {moreViews.length > 0 && (
        <details aria-label={t("skillLibrary.savedViews.more")}>
          <summary>{t("skillLibrary.savedViews.more")}</summary>
          {moreViews.map((view) => (
            <ViewButton activeViewId={activeViewId} key={view.id} onApply={onApply} onDelete={onDelete} view={view} />
          ))}
        </details>
      )}
      <button onClick={onSave} type="button">{t("skillLibrary.savedViews.save")}</button>
    </section>
  );
}
