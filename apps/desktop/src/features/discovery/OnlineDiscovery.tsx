import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError, nativeErrorCode } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { CheckboxField } from "../../ui/CheckboxField";
import { Icon } from "../../ui/Icon";
import { Input } from "../../ui/Input";
import {
  type LlmAdminFacade,
  type LlmCapabilitySettings,
  type LlmProviderView,
  nativeLlmFacade,
} from "../settings/llmApi";
import { ExternalLink } from "../markdown/ExternalLink";
import { SkillCard } from "../shared/skill-card/SkillCard";
import type { SkillCardViewModel } from "../shared/skill-card/SkillCardViewModel";
import type {
  DiscoverableRepoSkill,
  SearchCandidateStatus,
  SourceLocator,
  SourceSearchHit,
  SourceSearchPage,
} from "../../api/bindings";
import {
  isCandidateDismissedConflict,
  mergeCandidateEntries,
  type CandidateEntry,
} from "./api";
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
  /**
   * M-16：勾选 AI 辅助时读取能力开关/供应商/凭据状态的 facade。默认使用
   * 原生命令绑定，让状态检查在真实应用中开箱即用；测试注入替身。
   */
  llmFacade?: LlmAdminFacade;
  /** M-16：AI 未就绪时"前往设置"入口；缺省时跳转到应用设置路由。 */
  onOpenSettings?: () => void;
}

/** M-16：AI 搜索辅助的可用性四态（需求验收 7）。
 * - ready：能力开关开启且有可用供应商（连接可能仍未实测）；
 * - not_configured：没有启用的供应商，或启用的在线供应商缺少凭据；
 * - capability_disabled：AI 能力开关（online_search_assist）未开启；
 * - unverified：配置齐备但连接未经实测，或配置状态暂时不可读。 */
export type AssistReadiness =
  | { kind: "ready" }
  | { kind: "not_configured"; detail: "provider" | "credential" }
  | { kind: "capability_disabled" }
  | { kind: "unverified" };

/** 纯函数：由能力开关与供应商视图推导 AI 辅助可用性。绝不发起网络请求。 */
export function evaluateAssistReadiness(
  capabilities: LlmCapabilitySettings | null,
  providers: LlmProviderView[] | null,
): AssistReadiness {
  if (!capabilities || !providers) return { kind: "unverified" };
  const enabled = providers.filter((provider) => provider.config.enabled);
  if (enabled.length === 0) return { kind: "not_configured", detail: "provider" };
  if (!capabilities.online_search_assist) return { kind: "capability_disabled" };
  const primary = enabled.find((provider) => provider.is_default) ?? enabled[0]!;
  if (primary.config.deployment === "online" && !primary.credential_configured) {
    return { kind: "not_configured", detail: "credential" };
  }
  return { kind: "unverified" };
}

/** 未就绪到必须阻断伪 AI 路径的程度：未配置/被禁用属于确定性不可用；
 * 连接未知仍允许首次真实搜索去验证（那是真实尝试而非伪 AI）。 */
function blocksAssistPath(readiness: AssistReadiness | null): boolean {
  return (
    readiness?.kind === "not_configured" || readiness?.kind === "capability_disabled"
  );
}

/** M-16：四态的用户语言文案（i18n 键集中在此，避免渲染分支内散落）。 */
function readinessNotice(
  readiness: AssistReadiness,
  t: (key: string) => string,
): string {
  switch (readiness.kind) {
    case "ready":
      return t("discovery.search.assistReady");
    case "unverified":
      return t("discovery.search.assistUnverified");
    case "capability_disabled":
      return t("discovery.search.assistCapabilityDisabled");
    case "not_configured":
      return readiness.detail === "credential"
        ? t("discovery.search.assistNotConfiguredCredential")
        : t("discovery.search.assistNotConfiguredProvider");
  }
}

function sourceProvider(pageUrl: string, fallback: string | null): string {
  try {
    return new URL(pageUrl).host;
  } catch {
    return fallback ?? pageUrl;
  }
}

/** AI 搜索辅助的明确状态（P0-06 + M-16）：无配置、能力被禁用、取消、失败、
 * 成功；每种状态都必须告诉用户"普通搜索结果仍然可用"。 */
type AssistStatus =
  | { kind: "succeeded"; notice: string }
  | { kind: "unconfigured" }
  | { kind: "capability_disabled" }
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
  if (code === "llm.capability_disabled") {
    return { kind: "capability_disabled" };
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

export function OnlineDiscovery({ onStartImport, onImportDirectory, facade, importedNames, llmFacade = nativeLlmFacade, onOpenSettings }: OnlineDiscoveryProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [page, setPage] = useState<SourceSearchPage | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  // US-014：AI 搜索辅助默认关闭；开启后只做查询扩展与标记，不替代真实结果。
  const [assistEnabled, setAssistEnabled] = useState(false);
  const [assistStatus, setAssistStatus] = useState<AssistStatus | null>(null);
  // M-16：勾选即检查的 AI 可用性四态；null = 未勾选。
  const [assistReadiness, setAssistReadiness] = useState<AssistReadiness | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [libraryNames, setLibraryNames] = useState<Set<string>>(new Set());
  // P1-05：候选确认闭环。key = hit.source_id（即 provider_source_id）。
  const [candidates, setCandidates] = useState<Map<string, CandidateEntry>>(new Map());
  const [candidateBusyId, setCandidateBusyId] = useState<string | null>(null);
  const [candidateNotice, setCandidateNotice] = useState<string | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  // 在 JSX 闭包里使用收窄后的 facade 引用，避免可空参数的类型回退。
  const onlineFacade = facade;
  // P1-05：四个候选命令都可用才提供登记/忽略；缺失时如实隐藏动作，
  // 不渲染点了必然失败的按钮。
  const candidateFacade = onlineFacade
    && onlineFacade.listSearchCandidates
    && onlineFacade.saveSearchCandidates
    && onlineFacade.confirmSearchCandidate
    && onlineFacade.dismissSearchCandidate
    ? {
        list: onlineFacade.listSearchCandidates,
        save: onlineFacade.saveSearchCandidates,
        confirm: onlineFacade.confirmSearchCandidate,
        dismiss: onlineFacade.dismissSearchCandidate,
      }
    : null;
  // 挂载即加载持久化候选（跨会话恢复），用于结果行状态徽标初始化；
  // 加载失败不阻塞搜索闭环，后续操作的失败会如实出现在告警里。
  const listCandidatesAction = onlineFacade?.listSearchCandidates;
  useEffect(() => {
    if (!listCandidatesAction) return;
    let active = true;
    listCandidatesAction()
      .then((records) => {
        if (active) setCandidates((prev) => mergeCandidateEntries(prev, records));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [listCandidatesAction]);

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

  // M-16：勾选 AI 辅助时立即读取配置/能力开关/凭据状态；读取失败不猜测，
  // 按"连接未知"处理（搜索时仍会真实验证）。绝不在此发起模型请求。
  const evaluateAssistAvailability = useCallback(() => {
    if (!llmFacade) {
      setAssistReadiness({ kind: "unverified" });
      return;
    }
    let active = true;
    Promise.all([llmFacade.readCapabilityState(), llmFacade.listProviders()])
      .then(([capabilityState, providers]) => {
        if (active) {
          setAssistReadiness(evaluateAssistReadiness(capabilityState.capabilities, providers));
        }
      })
      .catch(() => {
        if (active) setAssistReadiness({ kind: "unverified" });
      });
    return () => {
      active = false;
    };
  }, [llmFacade]);

  const toggleAssist = (checked: boolean) => {
    setAssistEnabled(checked);
    setAssistStatus(null);
    if (checked) {
      void evaluateAssistAvailability();
    } else {
      // 明确切回普通搜索：可用性提示随之消失。
      setAssistReadiness(null);
    }
  };

  const openSettings = onOpenSettings ?? (() => window.location.assign("/settings"));

  const search = async () => {
    if (!facade || !query.trim()) return;
    setSearching(true);
    setSearchError(null);
    setAssistStatus(null);
    try {
      if (assistEnabled && facade.searchOnlineSourcesAssisted && blocksAssistPath(assistReadiness)) {
        // M-16：未就绪（未配置/被禁用）时阻断伪 AI 路径——不发起注定失败的
        // AI 请求，明确告知只跑普通搜索，并保留"前往设置"入口。
        const plain = await facade.searchOnlineSources({ query: query.trim(), limit: 20, owner: null });
        setPage(plain);
        setAssistStatus(
          assistReadiness?.kind === "capability_disabled"
            ? { kind: "capability_disabled" }
            : { kind: "unconfigured" },
        );
      } else if (assistEnabled && facade.searchOnlineSourcesAssisted) {
        try {
          const assisted = await facade.searchOnlineSourcesAssisted(query.trim());
          setPage(assisted);
          if (assisted.ai_assisted) {
            setAssistReadiness({ kind: "ready" });
            setAssistStatus({
              kind: "succeeded",
              notice: t("discovery.search.assistExtended", {
                query: assisted.expanded_query ?? query.trim(),
                count: assisted.items.filter((item) => item.via === "expanded_query").length,
              }),
            });
          }
        } catch (assistReason) {
          // 辅助失败按状态分类（无配置/禁用/取消/其他失败），回退基础搜索
          // （需求 5.9）并明确告知"结果仍然可用"。
          const outcome = classifyAssistFailure(assistReason, (reason) =>
            describeError(reason, "discovery.search.assistUnknownFailure"));
          setAssistStatus(outcome);
          setAssistReadiness(
            outcome.kind === "unconfigured"
              ? { kind: "not_configured", detail: "provider" }
              : outcome.kind === "capability_disabled"
                ? { kind: "capability_disabled" }
                : { kind: "unverified" },
          );
          const plain = await facade.searchOnlineSources({ query: query.trim(), limit: 20, owner: null });
          setPage(plain);
        }
      } else {
        if (assistEnabled) {
          // 需要辅助但当前环境未提供该能力：如实标注无配置状态。
          setAssistStatus({ kind: "unconfigured" });
          setAssistReadiness((current) => current ?? { kind: "not_configured", detail: "provider" });
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

  /** 确保该命中已有候选记录；未保存时先 save，再从返回的全量列表取状态。 */
  const ensureCandidateEntry = useCallback(
    async (hit: SourceSearchHit): Promise<CandidateEntry | null> => {
      if (!candidateFacade || !page) return null;
      const existing = candidates.get(hit.source_id);
      if (existing) return existing;
      const saved = await candidateFacade.save(page);
      setCandidates((prev) => mergeCandidateEntries(prev, saved));
      const savedRecord = saved.find((record) => record.provider_source_id === hit.source_id);
      return savedRecord ? { id: savedRecord.id, status: savedRecord.status } : null;
    },
    [candidateFacade, candidates, page],
  );

  const setCandidateEntryStatus = useCallback(
    (sourceId: string, status: SearchCandidateStatus) => {
      setCandidates((prev) => {
        const entry = prev.get(sourceId);
        if (!entry) return prev;
        const next = new Map(prev);
        next.set(sourceId, { ...entry, status });
        return next;
      });
    },
    [],
  );

  /**
   * 登记为来源：save（若尚未保存）+ confirm。后端把 confirmed→confirmed
   * 定义为幂等成功，已登记的行可以安全重按；dismissed→confirmed 会被
   * 原生层拒绝（reason=candidate_dismissed），这里在本地已知的两条路径上
   * 都按真实状态机处理，不臆造“恢复”转换。
   */
  const registerCandidate = useCallback(
    async (hit: SourceSearchHit) => {
      if (!candidateFacade || !page) return;
      setCandidateBusyId(hit.source_id);
      setCandidateError(null);
      setCandidateNotice(null);
      try {
        const entry = await ensureCandidateEntry(hit);
        if (!entry) {
          setCandidateError(describeError(new Error("candidate missing after save"), "discovery.online.candidate.failed"));
          return;
        }
        if (entry.status === "dismissed") {
          setCandidateError(t("discovery.online.candidate.dismissedConflict", { name: hit.name }));
          return;
        }
        await candidateFacade.confirm(entry.id);
        setCandidateEntryStatus(hit.source_id, "confirmed");
        setCandidateNotice(t("discovery.online.candidate.registerSucceeded", { name: hit.name }));
      } catch (reason) {
        if (isCandidateDismissedConflict(reason)) {
          setCandidateEntryStatus(hit.source_id, "dismissed");
          setCandidateError(t("discovery.online.candidate.dismissedConflict", { name: hit.name }));
          return;
        }
        setCandidateError(describeError(reason, "discovery.online.candidate.failed"));
      } finally {
        setCandidateBusyId(null);
      }
    },
    [candidateFacade, describeError, ensureCandidateEntry, page, setCandidateEntryStatus, t],
  );

  /** 忽略：save（若尚未保存）+ dismiss。后端对重复忽略幂等，confirmed 也可反悔。 */
  const dismissCandidate = useCallback(
    async (hit: SourceSearchHit) => {
      if (!candidateFacade || !page) return;
      setCandidateBusyId(hit.source_id);
      setCandidateError(null);
      setCandidateNotice(null);
      try {
        const entry = await ensureCandidateEntry(hit);
        if (!entry) {
          setCandidateError(describeError(new Error("candidate missing after save"), "discovery.online.candidate.failed"));
          return;
        }
        await candidateFacade.dismiss(entry.id);
        setCandidateEntryStatus(hit.source_id, "dismissed");
        setCandidateNotice(t("discovery.online.candidate.dismissSucceeded", { name: hit.name }));
      } catch (reason) {
        setCandidateError(describeError(reason, "discovery.online.candidate.failed"));
      } finally {
        setCandidateBusyId(null);
      }
    },
    [candidateFacade, describeError, ensureCandidateEntry, page, setCandidateEntryStatus, t],
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
              onChange={(event) => toggleAssist(event.target.checked)}
            />
            {assistEnabled && assistReadiness && !searching ? (
              // M-16：勾选即呈现可用性状态；未就绪时提供"前往设置"入口。
              // 不用 role=status，避免与搜索结果状态通告互相干扰。
              <>
                <p>{readinessNotice(assistReadiness, (key) => t(key as never))}</p>
                {assistReadiness.kind !== "ready" ? (
                  <Button onClick={openSettings} size="sm" variant="secondary">
                    {t("discovery.search.assistOpenSettings")}
                  </Button>
                ) : null}
              </>
            ) : null}
            {searchError ? <p role="alert">{searchError}</p> : null}
            {assistStatus && !searching ? (
              assistStatus.kind === "succeeded" ? (
                <p role="status">{assistStatus.notice}</p>
              ) : assistStatus.kind === "unconfigured" ? (
                <p role="status">{t("discovery.search.assistUnconfigured")}</p>
              ) : assistStatus.kind === "capability_disabled" ? (
                <p role="status">{t("discovery.search.assistCapabilityDisabled")}</p>
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
                const candidateEntry = candidates.get(hit.source_id) ?? null;
                // 只陈列可证实状态：候选状态、AI 扩展命中、已在库、不可安装可同时成立。
                const statuses: SkillCardViewModel["statuses"] = [];
                if (candidateEntry) {
                  // P1-05：候选状态徽标（待确认/已登记/已忽略），随候选归并状态更新。
                  statuses.push({
                    label: candidateEntry.status === "pending"
                      ? t("discovery.online.candidate.badgePending")
                      : candidateEntry.status === "confirmed"
                        ? t("discovery.online.candidate.badgeConfirmed")
                        : t("discovery.online.candidate.badgeDismissed"),
                    testId: `candidate-${hit.source_id}`,
                    tone: candidateEntry.status === "pending"
                      ? "info"
                      : candidateEntry.status === "confirmed"
                        ? "success"
                        : "neutral",
                  });
                }
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
                        <>
                          {candidateFacade ? (
                            <>
                              <Button
                                disabled={candidateBusyId !== null || candidateEntry?.status === "dismissed"}
                                onClick={() => void registerCandidate(hit)}
                                title={
                                  candidateEntry?.status === "dismissed"
                                    ? t("discovery.online.candidate.registerUnavailableHint")
                                    : candidateEntry?.status === "confirmed"
                                      ? t("discovery.online.candidate.registeredHint")
                                      : undefined
                                }
                                variant="secondary"
                              >
                                {candidateEntry?.status === "confirmed"
                                  ? t("discovery.online.candidate.registeredAction")
                                  : t("discovery.online.candidate.registerAction")}
                              </Button>
                              {candidateEntry?.status !== "dismissed" ? (
                                <Button
                                  disabled={candidateBusyId !== null}
                                  onClick={() => void dismissCandidate(hit)}
                                  variant="secondary"
                                >
                                  {t("discovery.online.candidate.dismissAction")}
                                </Button>
                              ) : null}
                            </>
                          ) : null}
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
                        </>
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
          {candidateFacade && candidateNotice ? <p role="status">{candidateNotice}</p> : null}
          {candidateFacade && candidateError ? <p role="alert">{candidateError}</p> : null}
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
