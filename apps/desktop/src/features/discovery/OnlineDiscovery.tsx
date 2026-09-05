import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { SourceSearchPage } from "../../api/bindings";
import type { DiscoveryFacade } from "./api";

export interface OnlineDiscoveryProps {
  onStartImport: () => void;
  /** When provided, the card renders the real skills.sh search workbench. */
  facade?: DiscoveryFacade;
}

function sourceProvider(pageUrl: string, fallback: string | null): string {
  try {
    return new URL(pageUrl).host;
  } catch {
    return fallback ?? pageUrl;
  }
}

export function OnlineDiscovery({ onStartImport, facade }: OnlineDiscoveryProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [page, setPage] = useState<SourceSearchPage | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const search = async () => {
    if (!facade || !query.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await facade.searchOnlineSources({ query: query.trim(), limit: 20, owner: null });
      setPage(result);
    } catch {
      setSearchError(t("discovery.search.failed"));
    } finally {
      setSearching(false);
    }
  };

  return (
    <article className="sh-discovery-card">
      <div className="sh-discovery-card__heading">
        <div>
          <p className="sh-discovery-card__eyebrow">{t("discovery.online.eyebrow")}</p>
          <h2>{t("discovery.online.title")}</h2>
        </div>
        <span aria-hidden="true" className="sh-discovery-card__icon">↗</span>
      </div>
      <p>{t("discovery.online.description")}</p>
      {facade ? (
        <div className="sh-discovery-card__search">
          <input
            aria-label={t("discovery.search.label")}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("discovery.search.label")}
            type="text"
            value={query}
          />
          <Button disabled={searching || !query.trim()} onClick={() => void search()} variant="secondary">
            {searching ? t("discovery.search.searching") : t("discovery.search.action")}
          </Button>
          {searchError ? <p role="alert">{searchError}</p> : null}
          {page ? (
            <ul className="sh-discovery-card__results">
              {page.items.map((hit) => (
                <li key={hit.source_id}>
                  <span>{hit.name}</span>
                  <span>
                    {t("discovery.search.source", {
                      provider: sourceProvider(hit.page_url, page.search_type),
                    })}
                  </span>
                  <span>{t("discovery.search.installs", { count: hit.installs })}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {!facade ? (
        <ul>
          <li>{t("discovery.online.factNoNetwork")}</li>
          <li>{t("discovery.online.factPreview")}</li>
        </ul>
      ) : null}
      <Button onClick={onStartImport} variant="secondary">{t("discovery.importSkill")}</Button>
    </article>
  );
}
