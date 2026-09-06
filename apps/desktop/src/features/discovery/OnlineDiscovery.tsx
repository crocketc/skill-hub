import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { ExternalLink } from "../markdown/ExternalLink";
import type {
  DiscoverableRepoSkill,
  SourceLocator,
  SourceSearchHit,
  SourceSearchPage,
} from "../../api/bindings";
import type { DiscoveryFacade } from "./api";

export interface OnlineDiscoveryProps {
  onStartImport: () => void;
  /** Called with the downloaded local directory so it enters the import wizard. */
  onImportDirectory: (directory: string) => void;
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

/**
 * AR-003：在线命中没有结构化 owner/repo 字段（bindings 只有 source 定位符），
 * 只能保守地从 GitHub URL 解析仓库；解析失败返回 null，由调用方禁用安装，
 * 绝不伪造仓库参数。
 */
export function parseGitHubRepo(locator: SourceLocator): { owner: string; repo: string } | null {
  const url = locator.https_url ?? locator.git_url;
  if (!url) return null;
  const https = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (https) return { owner: https[1], repo: https[2].replace(/\.git$/, "") };
  const ssh = url.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return null;
}

/** 复用仓库发现管线的下载参数：契约没有仓库内路径字段，空目录=整仓。 */
function toRepoSkill(hit: SourceSearchHit): DiscoverableRepoSkill | null {
  const repo = parseGitHubRepo(hit.source.locator);
  if (!repo) return null;
  return {
    key: `${repo.owner}/${repo.repo}:`,
    name: hit.name,
    description: "",
    directory: "",
    readme_url: null,
    repo_owner: repo.owner,
    repo_name: repo.repo,
    // 空分支是宿主的“默认分支回退”哨兵。
    repo_branch: "",
  };
}

export function OnlineDiscovery({ onStartImport, onImportDirectory, facade }: OnlineDiscoveryProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [page, setPage] = useState<SourceSearchPage | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // 在 JSX 闭包里使用收窄后的 facade 引用，避免可空参数的类型回退。
  const onlineFacade = facade;

  const describeInstallError = useCallback(
    (reason: unknown) =>
      describeNativeError(
        reason,
        (key, options) => String(t(key as never, options as never)),
        "discovery.online.installFailed",
      ),
    [t],
  );

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

  // AR-003：与仓库发现/lock 导入共用 download_repo_skill 下载管线，
  // 下载成功后把临时目录交给既有导入向导，不新建任何伪造安装。
  const install = useCallback(
    async (hit: SourceSearchHit) => {
      if (!facade) return;
      const skill = toRepoSkill(hit);
      if (!skill) return;
      setDownloadingId(hit.source_id);
      setInstallError(null);
      try {
        const downloaded = await facade.downloadRepoSkill(skill);
        onImportDirectory(downloaded.local_path);
      } catch (reason) {
        setInstallError(describeInstallError(reason));
      } finally {
        setDownloadingId(null);
      }
    },
    [describeInstallError, facade, onImportDirectory],
  );

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
      {onlineFacade ? (
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
              {page.items.map((hit) => {
                const skill = toRepoSkill(hit);
                return (
                  <li key={hit.source_id}>
                    <span>{hit.name}</span>
                    <span>
                      {t("discovery.search.source", {
                        provider: sourceProvider(hit.page_url, page.search_type),
                      })}
                    </span>
                    <span>{t("discovery.search.installs", { count: hit.installs })}</span>
                    <ExternalLink
                      onOpen={() => void onlineFacade.openExternalUrl(hit.page_url)}
                      target={hit.page_url}
                    >
                      {t("discovery.online.viewAction")}
                    </ExternalLink>
                    <Button
                      disabled={!skill || downloadingId !== null}
                      onClick={() => void install(hit)}
                      title={skill ? undefined : t("discovery.online.installUnavailable")}
                      variant="secondary"
                    >
                      {downloadingId === hit.source_id
                        ? t("discovery.online.installing")
                        : t("discovery.online.installAction")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {installError ? <p role="alert">{installError}</p> : null}
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
