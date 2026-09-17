import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { SkillRelationshipCandidate } from "../api";

export interface GraphSearchProps {
  /** 选中唯一结果或用户点选后回调（由页面负责跳转）。 */
  onPick: (skillId: string) => void;
  search: (text: string) => Promise<SkillRelationshipCandidate[]>;
}

type SearchState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "choices"; items: SkillRelationshipCandidate[] }
  | { phase: "none" }
  | { phase: "error" };

/** 原名/别名搜索（任务 6）：多结果必须让用户选择，单一结果直接前往。 */
export function GraphSearch({ onPick, search }: GraphSearchProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [state, setState] = useState<SearchState>({ phase: "idle" });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const query = text.trim();
    if (!query || state.phase === "loading") return;
    setState({ phase: "loading" });
    try {
      const items = await search(query);
      if (items.length === 1) {
        onPick(items[0]!.skill_id);
        setState({ phase: "idle" });
        return;
      }
      setState(items.length === 0 ? { phase: "none" } : { phase: "choices", items });
    } catch {
      setState({ phase: "error" });
    }
  };

  return (
    <div className="sh-graph-search">
      <form className="sh-graph-search__form" onSubmit={submit}>
        <label className="sh-graph-search__label" htmlFor="sh-graph-search-input">
          {t("relationships.graph.searchLabel")}
        </label>
        <input
          id="sh-graph-search-input"
          className="sh-graph-search__input"
          type="search"
          value={text}
          placeholder={t("relationships.graph.searchPlaceholder")}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          className="sh-button sh-button--secondary sh-button--sm"
          disabled={state.phase === "loading"}
        >
          {t("relationships.graph.searchSubmit")}
        </button>
      </form>
      {state.phase === "choices" ? (
        <div className="sh-graph-search__results">
          <p>{t("relationships.graph.searchChoiceHint")}</p>
          <ul>
            {state.items.map((item) => (
              <li key={item.skill_id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(item.skill_id);
                    setState({ phase: "idle" });
                  }}
                >
                  <span className="sh-graph-search__name">{item.display_name}</span>
                  {item.matched_alias ? (
                    <span className="sh-graph-search__alias">
                      {t("relationships.graph.searchMatchedAlias", { alias: item.matched_alias })}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {state.phase === "none" ? <p role="status">{t("relationships.graph.searchNoResults")}</p> : null}
      {state.phase === "error" ? <p role="alert">{t("relationships.graph.searchFailed")}</p> : null}
    </div>
  );
}
