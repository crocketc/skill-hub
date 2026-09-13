import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DataState } from "../../ui/DataState";
import { Input } from "../../ui/Input";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { Switch } from "../../ui/Switch";
import { ExternalLink } from "../markdown/ExternalLink";
import type { SkillRepoView } from "../../api/bindings";
import { describeRepoWarning, formatRelativeScanTime, parseRepoInput } from "./api";
import type { DiscoveryFacade } from "./api";
import "./RepoManagerPage.css";

export interface RepoManagerPageProps {
  facade: DiscoveryFacade;
}

const repoKey = (repo: SkillRepoView["repo"]) => `${repo.owner}/${repo.name}`;

/**
 * D4 仓库管理独立页：维护参与仓库发现的 GitHub 仓库。配置（含启停）持久化
 * 于 settings；每次扫描（整体或逐仓刷新）的最近结果按仓库保留，供用户
 * 判断“哪些仓库值得再扫”。删除只影响发现入口，绝不触碰已导入的 Skill。
 */
export function RepoManagerPage({ facade }: RepoManagerPageProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? undefined;
  const [views, setViews] = useState<SkillRepoView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [listRefreshing, setListRefreshing] = useState(false);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<SkillRepoView | null>(null);

  const describe = useCallback(
    (reason: unknown) =>
      describeNativeError(
        reason,
        (key, options) => String(t(key as never, options as never)),
        "discovery.repo.failedGeneric",
      ),
    [t],
  );

  const load = useCallback(async () => {
    setError(null);
    setListRefreshing(true);
    try {
      setViews(await facade.listSkillRepos());
      setLoaded(true);
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setListRefreshing(false);
    }
  }, [describe, facade]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = useCallback(async () => {
    const parsed = parseRepoInput(input);
    if (!parsed) {
      setInputError(t("discovery.repoManager.inputInvalid"));
      return;
    }
    setInputError(null);
    setAdding(true);
    setError(null);
    try {
      setViews(await facade.addSkillRepo({ ...parsed, enabled: true }));
      setInput("");
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setAdding(false);
    }
  }, [describe, facade, input, t]);

  const toggleRepo = useCallback(
    async (view: SkillRepoView) => {
      setError(null);
      try {
        setViews(
          await facade.addSkillRepo({ ...view.repo, enabled: !view.repo.enabled }),
        );
      } catch (reason) {
        setError(describe(reason));
      }
    },
    [describe, facade],
  );

  const refreshRepo = useCallback(
    async (view: SkillRepoView) => {
      if (!facade.refreshSkillRepo) {
        setError(t("discovery.repoManager.unsupportedAction"));
        return;
      }
      const key = repoKey(view.repo);
      setRefreshingKey(key);
      setError(null);
      try {
        await facade.refreshSkillRepo(view.repo.owner, view.repo.name);
        // 刷新完成后重拉列表，让持久化的“最近一次扫描”原样回显。
        setViews(await facade.listSkillRepos());
      } catch (reason) {
        setError(
          `${t("discovery.repoManager.refreshFailed")} ${describe(reason)}`,
        );
      } finally {
        setRefreshingKey(null);
      }
    },
    [describe, facade, t],
  );

  const removeRepo = useCallback(async () => {
    if (!pendingRemoval) return;
    setError(null);
    try {
      setViews(
        await facade.removeSkillRepo(pendingRemoval.repo.owner, pendingRemoval.repo.name),
      );
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setPendingRemoval(null);
    }
  }, [describe, facade, pendingRemoval]);

  const scanFacts = (view: SkillRepoView) => {
    const { scan } = view;
    if (!scan) {
      return (
        <p className="sh-repo-manager__scan">
          {t("discovery.repoManager.neverScanned")}
        </p>
      );
    }
    const time =
      formatRelativeScanTime(scan.scanned_at, { locale })
      ?? t("discovery.repoManager.neverScanned");
    return (
      <p className="sh-repo-manager__scan">
        <span className="sh-repo-manager__scan-label">
          {t("discovery.repoManager.lastScan")}
        </span>
        <span>{time}</span>
        {scan.ok ? (
          <span>
            {t("discovery.repoManager.candidates", { candidates: scan.candidate_count })}
          </span>
        ) : (
          <span className="sh-repo-manager__scan-error">
            {describeRepoWarning(scan.error ?? "", (key, options) =>
              String(t(key as never, options as never)))}
          </span>
        )}
      </p>
    );
  };

  return (
    <PageFrame width="wide">
      <PageHeader
        description={t("discovery.repoManager.description")}
        title={t("discovery.repoManager.title")}
        actions={
          <Button
            disabled={listRefreshing}
            loading={listRefreshing}
            onClick={() => void load()}
            variant="secondary"
          >
            {listRefreshing
              ? t("discovery.repoManager.refreshingList")
              : t("discovery.repoManager.refreshList")}
          </Button>
        }
      />

      {error ? (
        <p role="alert" className="sh-repo-manager__alert">
          {error}
        </p>
      ) : null}

      <section aria-label={t("discovery.repo.add")} className="sh-repo-manager__add">
        <Input
          aria-label={t("discovery.repoManager.addLabel")}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleAdd();
          }}
          placeholder={t("discovery.repoManager.addPlaceholder")}
          type="text"
          value={input}
        />
        <Button disabled={adding} loading={adding} onClick={() => void handleAdd()}>
          {t("discovery.repo.add")}
        </Button>
        {inputError ? (
          <p role="alert" className="sh-repo-manager__input-error">
            {inputError}
          </p>
        ) : null}
      </section>

      {!loaded && !error ? (
        <DataState message={t("dataState.loading")} state="loading" />
      ) : loaded && views.length === 0 ? (
        <DataState message={t("discovery.repo.empty")} state="empty" />
      ) : (
        <ul className="sh-repo-manager__list">
          {views.map((view) => {
            const key = repoKey(view.repo);
            return (
              <li
                className={
                  view.repo.enabled
                    ? "sh-repo-manager__row"
                    : "sh-repo-manager__row sh-repo-manager__row--disabled"
                }
                key={key}
              >
                <div className="sh-repo-manager__id">
                  <span className="sh-repo-manager__name">{key}</span>
                  <span className="sh-repo-manager__branch">
                    {view.repo.branch || t("discovery.repoManager.defaultBranch")}
                  </span>
                  <ExternalLink
                    ariaLabel={t("discovery.repoManager.openOnGithub", { repo: key })}
                    onOpen={() =>
                      void facade.openExternalUrl(`https://github.com/${key}`)
                    }
                    target={`https://github.com/${key}`}
                  >
                    GitHub
                  </ExternalLink>
                </div>
                {scanFacts(view)}
                <div className="sh-repo-manager__actions">
                  <Switch
                    checked={view.repo.enabled}
                    label={t("discovery.repo.enabled")}
                    onChange={() => void toggleRepo(view)}
                  />
                  <Button
                    aria-label={t("discovery.repoManager.refreshAria", { repo: key })}
                    disabled={refreshingKey !== null}
                    loading={refreshingKey === key}
                    onClick={() => void refreshRepo(view)}
                    size="sm"
                    variant="secondary"
                  >
                    {/* 审查 m2（2026-09-14）：可见文案与可访问名拆键——可见
                        文案固定“刷新”，带仓库坐标的可访问名走 refreshAria。 */}
                    {refreshingKey === key
                      ? t("discovery.repoManager.refreshingRepo")
                      : t("discovery.repoManager.refresh")}
                  </Button>
                  <ConfirmDialog
                    cancelLabel={t("actions.cancel")}
                    confirmLabel={t("discovery.repo.confirmRemove")}
                    description={t("discovery.repo.confirmRemoveDescription", {
                      repo: key,
                    })}
                    onConfirm={() => void removeRepo()}
                    title={t("discovery.repo.confirmRemoveTitle")}
                    trigger={
                      <Button onClick={() => setPendingRemoval(view)} variant="ghost">
                        {t("discovery.repo.remove")}
                      </Button>
                    }
                    variant="primary"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </PageFrame>
  );
}
