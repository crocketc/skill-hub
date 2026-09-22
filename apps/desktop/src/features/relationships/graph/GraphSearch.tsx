import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
  | { activeIndex: number; phase: "choices"; items: SkillRelationshipCandidate[] }
  | { phase: "none" }
  | { phase: "error" };

/** 原名/别名搜索（任务 6）：多结果必须让用户选择，单一结果直接前往。 */
export function GraphSearch({ onPick, search }: GraphSearchProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const rootRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const listboxId = "sh-graph-search-results";

  const loadCandidates = useCallback(async (query: string, direct: boolean) => {
    if (!query) return;
    const requestId = ++requestRef.current;
    setState({ phase: "loading" });
    try {
      const items = await search(query);
      if (requestId !== requestRef.current) return;
      if (direct && items.length === 1) {
        onPick(items[0]!.skill_id);
        setState({ phase: "idle" });
        return;
      }
      setState(items.length === 0 ? { phase: "none" } : { activeIndex: 0, phase: "choices", items });
    } catch {
      if (requestId !== requestRef.current) return;
      setState({ phase: "error" });
    }
  }, [onPick, search]);

  useEffect(() => {
    const query = text.trim();
    if (!query) {
      requestRef.current += 1;
      setState({ phase: "idle" });
      return undefined;
    }
    const timer = window.setTimeout(() => void loadCandidates(query, false), 150);
    return () => window.clearTimeout(timer);
  }, [loadCandidates, text]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const query = text.trim();
    await loadCandidates(query, true);
  };

  const pick = (skillId: string) => {
    requestRef.current += 1;
    onPick(skillId);
    setState({ phase: "idle" });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (state.phase !== "choices") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setState({
        ...state,
        activeIndex: (state.activeIndex + offset + state.items.length) % state.items.length,
      });
    } else if (event.key === "Enter" && state.items[state.activeIndex]) {
      event.preventDefault();
      pick(state.items[state.activeIndex]!.skill_id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      requestRef.current += 1;
      setState({ phase: "idle" });
    }
  };

  return (
    <div className="sh-graph-search" ref={rootRef}>
      <form className="sh-graph-search__form" onSubmit={submit}>
        <label className="sh-graph-search__label sh-visually-hidden" htmlFor="sh-graph-search-input">
          {t("relationships.graph.searchLabel")}
        </label>
        <input
          id="sh-graph-search-input"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={state.phase === "choices" ? listboxId : undefined}
          aria-expanded={state.phase === "choices"}
          aria-activedescendant={state.phase === "choices" ? `sh-graph-search-option-${state.activeIndex}` : undefined}
          className="sh-graph-search__input"
          type="search"
          value={text}
          placeholder={t("relationships.graph.searchPlaceholder")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={(event) => {
            if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
              requestRef.current += 1;
              setState({ phase: "idle" });
            }
          }}
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
          <ul aria-label={t("relationships.graph.searchSuggestions")} id={listboxId} role="listbox">
            {state.items.map((item, index) => (
              <li key={item.skill_id}>
                <button
                  aria-selected={index === state.activeIndex}
                  id={`sh-graph-search-option-${index}`}
                  role="option"
                  type="button"
                  // Select before the input can blur and dismiss the list. This keeps
                  // pointer selection deterministic when focus events are delayed.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(item.skill_id);
                  }}
                  onMouseEnter={() => setState({ ...state, activeIndex: index })}
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
