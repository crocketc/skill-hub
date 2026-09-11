import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError, nativeErrorCode } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { CheckboxField } from "../../ui/CheckboxField";
import { Icon } from "../../ui/Icon";
import { Input } from "../../ui/Input";
import { ExternalLink } from "../markdown/ExternalLink";
import { SkillCard } from "../shared/skill-card/SkillCard";
import type { SkillCardViewModel } from "../shared/skill-card/SkillCardViewModel";
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
  /**
   * C2 收口：可选地提供库内 Skill 显示名（复用既有 listSkills 查询），
   * 用于结果卡的"已在库"标记；按名称保守比对，不声称是同一来源。
   */
  importedNames?: () => Promise<string[]>;
}

function sourceProvider(pageUrl: string, fallback: string | null): string {
  try {
    return new URL(pageUrl).host;
  } catch {
    return fallback ?? pageUrl;
  }
}

/** AI 搜索辅助的四种明确状态（P0-06）：无配置、取消、失败、成功；
 * 每种状态都必须告诉用户"普通搜索结果仍然可用"。 */
type AssistStatus =
  | { kind: "succeeded"; notice: string }
  | { kind: "unconfigured" }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: string };

function classifyAssistFailure(
  reason: unknown,
  describe: (reason: unknown) => string,
): AssistStatus {
  const code = nativeErrorCode(reason);
  if (
    code === "llm.not_configured"
    || code === "credential.unavailable"
    || code === "llm.credential_read_failed"
  ) {
    return { kind: "unconfigured" };
  }
  if (code === "llm.cancelled") {
    return { kind: "cancelled" };
  }
  return { kind: "failed", reason: describe(reason) };
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

/** GitHub tree URL 解析出的仓库内定位：分支 + 可选子目录。 */
export interface GitHubTreeRef {
  branch: string;
  directory: string;
}

/**
 * P1-04：从 `…/tree/<branch>/<dir…>` 形态解析分支与仓库内目录；
 * 命中的 locator 常是这种形态（如 `https://github.com/anthropics/skills/tree/main/pdf`）。
 * 依序尝试候选 URL（locator → install_url → page_url）；解析不出 tree 形态
 * 返回 null，由调用方保持整仓下载并以可见状态告知，绝不静默或伪造目录。
 */
export function parseGitHubRepoTree(
  candidateUrls: (string | null | undefined)[],
): GitHubTreeRef | null {
  for (const url of candidateUrls) {
    if (!url) continue;
    const match = url
      .match(/^https:\/\/github\.com\/[^/]+\/[^/?#]+\/tree\/([^/?#]+)(?:\/([^?#]*))?(?:[?#].*)?$/i);
    if (!match) continue;
    const branch = decodeURIComponent(match[1]);
    const directory = match[2]
      ? decodeURIComponent(match[2]).replace(/\/+$/, "")
      : "";
    return { branch, directory };
  }
  return null;
}

/**
 * 单 Skill 专用安装的下载参数：从命中 URL 解析 branch+directory，
 * `download_repo_skill` 只复制该 Skill 子目录；解析不出 tree 时
 * directory/branch 保持空串（整仓 + 默认分支回退哨兵），由卡片明示。
 */
export function toRepoSkill(hit: SourceSearchHit): DiscoverableRepoSkill | null {
  const repo = parseGitHubRepo(hit.source.locator);
  if (!repo) return null;
  const tree = parseGitHubRepoTree([
    hit.source.locator.https_url ?? null,
    hit.install_url,
    hit.page_url,
  ]);
  const directory = tree?.directory ?? "";
  const branch = tree?.branch ?? "";
  return {
    key: `${repo.owner}/${repo.repo}:${directory}`,
    name: hit.name,
    description: "",
    directory,
    readme_url: null,
    repo_owner: repo.owner,
    repo_name: repo.repo,
    // 空分支是宿主的“默认分支回退”哨兵。
    repo_branch: branch,
  };
}

export function OnlineDiscovery({ onStartImport, onImportDirectory, facade, importedNames }: OnlineDiscoveryProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [page, setPage] = useState<SourceSearchPage | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  // US-014：AI 搜索辅助默认关闭；开启后只做查询扩展与标记，不替代真实结果。
  const [assistEnabled, setAssistEnabled] = useState(false);
  const [assistStatus, setAssistStatus] = useState<AssistStatus | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [libraryNames, setLibraryNames] = useState<Set<string>>(new Set());
  // 在 JSX 闭包里使用收窄后的 facade 引用，避免可空参数的类型回退。
  const onlineFacade = facade;

  useEffect(() => {
    if (!importedNames) return;
    let active = true;
    importedNames()
      .then((names) => {
        if (active) setLibraryNames(new Set(names.map((name) => name.trim().toLowerCase())));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [importedNames]);

  const describeError = useCallback(
    (reason: unknown, genericKey: string) =>
      describeNativeError(
        reason,
        (key, options) => String(t(key as never, options as never)),
        genericKey,
      ),
    [t],
  );

  const describeInstallError = useCallback(
    (reason: unknown) => describeError(reason, "discovery.online.installFailed"),
    [describeError],
  );

  const search = async () => {
    if (!facade || !query.trim()) return;
    setSearching(true);
    setSearchError(null);
    setAssistStatus(null);
    try {
      if (assistEnabled && facade.searchOnlineSourcesAssisted) {
        try {
          const assisted = await facade.searchOnlineSourcesAssisted(query.trim());
          setPage(assisted);
          if (assisted.ai_assisted) {
            setAssistStatus({
              kind: "succeeded",
              notice: t("discovery.search.assistExtended", {
                query: assisted.expanded_query ?? query.trim(),
                count: assisted.items.filter((item) => item.via === "expanded_query").length,
              }),
            });
          }
        } catch (assistReason) {
          // 辅助失败按状态分类（无配置/取消/其他失败），回退基础搜索
          // （需求 5.9）并明确告知"结果仍然可用"。
          const plain = await facade.searchOnlineSources({ query: query.trim(), limit: 20, owner: null });
          setPage(plain);
          setAssistStatus(
            classifyAssistFailure(assistReason, (reason) =>
              describeError(reason, "discovery.search.assistUnknownFailure")),
          );
        }
      } else {
        if (assistEnabled) {
          // 需要辅助但当前环境未提供该能力：如实标注无配置状态。
          setAssistStatus({ kind: "unconfigured" });
        }
        const result = await facade.searchOnlineSources({ query: query.trim(), limit: 20, owner: null });
        setPage(result);
      }
    } catch (reason) {
      setSearchError(describeError(reason, "discovery.search.failed"));
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
    <section aria-label={t("discovery.online.title")} className="sh-discovery-module">
      <header className="sh-discovery-module__heading">
        <div>
          <p className="sh-discovery-module__eyebrow">{t("discovery.online.eyebrow")}</p>
          <h2>{t("discovery.online.title")}</h2>
        </div>
        <span aria-hidden="true" className="sh-discovery-module__icon">
          <Icon name="open-external" size={24} />
        </span>
      </header>
      <p className="sh-discovery-module__description">{t("discovery.online.description")}</p>
      {onlineFacade ? (
        <div className="sh-discovery-module__body">
          <div className="sh-discovery-module__controls">
            <Input
              aria-label={t("discovery.search.label")}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("discovery.search.label")}
              type="text"
              value={query}
            />
            <Button disabled={searching || !query.trim()} onClick={() => void search()} variant="secondary">
              {searching ? t("discovery.search.searching") : t("discovery.search.action")}
            </Button>
            <CheckboxField
              checked={assistEnabled}
              label={t("discovery.search.assistToggle")}
              onChange={(event) => {
                setAssistEnabled(event.target.checked);
                setAssistStatus(null);
              }}
            />
            {searchError ? <p role="alert">{searchError}</p> : null}
            {assistStatus && !searching ? (
              assistStatus.kind === "succeeded" ? (
                <p role="status">{assistStatus.notice}</p>
              ) : assistStatus.kind === "unconfigured" ? (
                <p role="status">{t("discovery.search.assistUnconfigured")}</p>
              ) : assistStatus.kind === "cancelled" ? (
                <p role="status">{t("discovery.search.assistCancelled")}</p>
              ) : (
                <p role="status">
                  {t("discovery.search.assistFailedFallback")}{" "}
                  {t("discovery.search.assistFailureReason", { reason: assistStatus.reason })}
                </p>
              )
            ) : null}
            {searching ? <p role="status">{t("discovery.online.searchingStatus")}</p> : null}
            {!page && !searching ? (
              <p role="status">{t("discovery.online.initialHint")}</p>
            ) : null}
            {page && !searching && page.items.length === 0 ? (
              <p>{t("discovery.online.empty")}</p>
            ) : null}
          </div>
          {page ? (
            <div className="sh-discovery-results-zone">
              <ul
                aria-busy={searching}
                aria-label={t("discovery.search.results")}
                className="sh-discovery-results"
              >
              {page.items.map((hit) => {
                const skill = toRepoSkill(hit);
                const alreadyImported = libraryNames.has(hit.name.trim().toLowerCase());
                // 只陈列可证实状态：AI 扩展命中、已在库、不可安装可同时成立。
                const statuses: SkillCardViewModel["statuses"] = [];
                if (hit.via === "expanded_query") {
                  statuses.push({
                    label: t("discovery.search.assistHit"),
                    testId: `assist-${hit.source_id}`,
                    tone: "info",
                  });
                }
                if (alreadyImported) {
                  statuses.push({
                    label: t("discovery.online.alreadyImported"),
                    testId: `imported-${hit.source_id}`,
                    tone: "success",
                  });
                }
                if (!skill) {
                  statuses.push({ label: t("discovery.card.status.notInstallable"), tone: "warning" });
                } else if (skill.directory === "") {
                  // P1-04：解析不出仓库内目录时退回整仓下载，但必须明示，不静默。
                  statuses.push({ label: t("discovery.card.status.wholeRepo"), tone: "warning" });
                }
                const card: SkillCardViewModel = {
                  id: hit.source_id,
                  name: hit.name,
                  sourceType: "online",
                  sourceLabel: t("discovery.search.source", {
                    provider: sourceProvider(hit.page_url, page.search_type),
                  }),
                  sourceAddress: hit.page_url,
                  metrics: [t("discovery.search.installs", { count: hit.installs })],
                  statuses,
                };
                return (
                  <li key={hit.source_id}>
                    <SkillCard
                      primaryAction={
                        <Button
                          disabled={!skill || downloadingId !== null || alreadyImported}
                          onClick={() => void install(hit)}
                          title={skill
                            ? alreadyImported
                              ? t("discovery.online.alreadyImported")
                              : undefined
                            : t("discovery.online.installUnavailable")}
                          variant="secondary"
                        >
                          {downloadingId === hit.source_id
                            ? t("discovery.online.installing")
                            : t("discovery.online.installAction")}
                        </Button>
                      }
                      secondaryAction={
                        <ExternalLink
                          onOpen={() => void onlineFacade.openExternalUrl(hit.page_url)}
                          target={hit.page_url}
                        >
                          {t("discovery.online.viewAction")}
                        </ExternalLink>
                      }
                      skill={card}
                    />
                  </li>
                );
              })}
              </ul>
            </div>
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
      <div>
        <Button onClick={onStartImport} variant="secondary">{t("discovery.importSkill")}</Button>
      </div>
    </section>
  );
}
