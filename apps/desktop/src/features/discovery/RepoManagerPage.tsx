import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { DataState } from "../../ui/DataState";
import { Field } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
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
 * DEV-91（2026-09-25 验收反馈）：整宽横排行卡——左（名称/分支/识别数）
 * 右（启停 + 刷新/外链/移除图标）；GitHub 文字按钮换右上箭头图标，移除
 * 换垃圾桶图标（确认弹窗保留）。布局与本页耦合，不再复用 shared 卡片，
 * 仓库发现页保持原样。
 */
export function RepoManagerPage({ facade }: RepoManagerPageProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? undefined;
  const [views, setViews] = useState<SkillRepoView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  // DEV-91：分支拆成独立输入框；留空 = 后端默认分支。
  const [branchInput, setBranchInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [listRefreshing, setListRefreshing] = useState(false);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<SkillRepoView | null>(null);
  // 遗留风险清理（2026-09-14）：启停/移除补防抖——ref 守卫挡住任何路径的
  // 重入，state 驱动控件禁用给出可视反馈（与 refresh 的 busy 模式一致）。
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const toggleBusyRef = useRef(false);
  const [removing, setRemoving] = useState(false);
  const removingRef = useRef(false);

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
      // 分支框优先于 URL 内嵌 /tree/分支；两者都没有 = 默认分支（空串）。
      const branch = branchInput.trim() || parsed.branch;
      setViews(await facade.addSkillRepo({ ...parsed, branch, enabled: true }));
      setInput("");
      setBranchInput("");
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setAdding(false);
    }
  }, [branchInput, describe, facade, input, t]);

  const toggleRepo = useCallback(
    async (view: SkillRepoView) => {
      if (toggleBusyRef.current) return;
      toggleBusyRef.current = true;
      setTogglingKey(repoKey(view.repo));
      setError(null);
      try {
        setViews(
          await facade.addSkillRepo({ ...view.repo, enabled: !view.repo.enabled }),
        );
      } catch (reason) {
        setError(describe(reason));
      } finally {
        toggleBusyRef.current = false;
        setTogglingKey(null);
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
    if (!pendingRemoval || removingRef.current) return;
    removingRef.current = true;
    setRemoving(true);
    setError(null);
    try {
      setViews(
        await facade.removeSkillRepo(pendingRemoval.repo.owner, pendingRemoval.repo.name),
      );
    } catch (reason) {
      setError(describe(reason));
    } finally {
      removingRef.current = false;
      setRemoving(false);
      setPendingRemoval(null);
    }
  }, [describe, facade, pendingRemoval]);

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
        <h2 className="sh-repo-manager__add-title">{t("discovery.repoManager.addTitle")}</h2>
        <Field label={t("discovery.repoManager.urlLabel")} id="repo-manager-url">
          <Input
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleAdd();
            }}
            placeholder={t("discovery.repoManager.addPlaceholder")}
            type="text"
            value={input}
          />
        </Field>
        <Field label={t("discovery.repoManager.branchLabel")} id="repo-manager-branch">
          <Input
            onChange={(event) => setBranchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleAdd();
            }}
            placeholder="main"
            type="text"
            value={branchInput}
          />
        </Field>
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
        <div className="sh-repo-manager__cards">
          <h2 className="sh-repo-manager__list-title">{t("discovery.repoManager.listTitle")}</h2>
          <ul className="sh-repository-cards">
          {views.map((view) => {
            const key = repoKey(view.repo);
            const { scan } = view;
            const branchLabel = view.repo.branch || t("discovery.repoManager.defaultBranch");
            return (
              <li key={key}>
                <article
                  aria-label={key}
                  className={`sh-repo-manager__card${view.repo.enabled ? "" : " sh-repo-manager__card--disabled"}`}
                  data-repository-card={key}
                  data-testid="repository-card"
                >
                  <div className="sh-repo-manager__card-main">
                    <h3 className="sh-repo-manager__card-title">{key}</h3>
                    <div className="sh-repo-manager__card-meta">
                      <span className="sh-repo-manager__branch">
                        <span>{t("discovery.repoManager.branchLabel")}</span>
                        <span>{branchLabel}</span>
                      </span>
                      {scan?.ok ? (
                        <span className="sh-repo-manager__chip">
                          {t("discovery.repoManager.candidatesChip", { count: scan.candidate_count })}
                        </span>
                      ) : null}
                      {scan ? (
                        <span className="sh-repo-manager__scan-time">
                          <span>{t("discovery.repoManager.lastScan")}</span>
                          <span>
                            {formatRelativeScanTime(scan.scanned_at, { locale })
                              ?? t("discovery.repoManager.neverScanned")}
                          </span>
                        </span>
                      ) : (
                        <span className="sh-repo-manager__scan-time">
                          {t("discovery.repoManager.neverScanned")}
                        </span>
                      )}
                      {scan && !scan.ok ? (
                        <span className="sh-repo-manager__scan-error">
                          {describeRepoWarning(scan.error ?? "", (key, options) =>
                            String(t(key as never, options as never)))}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="sh-repo-manager__card-actions">
                    <Switch
                      checked={view.repo.enabled}
                      disabled={togglingKey !== null}
                      label={t("discovery.repo.enabled")}
                      onChange={() => void toggleRepo(view)}
                    />
                    <IconButton
                      aria-label={t("discovery.repoManager.refreshAria", { repo: key })}
                      disabled={refreshingKey !== null}
                      icon="update"
                      label={t("discovery.repoManager.refreshAria", { repo: key })}
                      onClick={() => void refreshRepo(view)}
                    />
                    <ExternalLink
                      ariaLabel={t("discovery.repoManager.openOnGithub", { repo: key })}
                      onOpen={() =>
                        void facade.openExternalUrl(`https://github.com/${key}`)
                      }
                      target={`https://github.com/${key}`}
                    >
                      <Icon aria-hidden="true" name="open-external" size={20} />
                    </ExternalLink>
                    <ConfirmDialog
                      cancelLabel={t("actions.cancel")}
                      confirmDisabled={removing}
                      confirmLabel={t("discovery.repo.confirmRemove")}
                      description={t("discovery.repo.confirmRemoveDescription", {
                        repo: key,
                      })}
                      onConfirm={() => void removeRepo()}
                      title={t("discovery.repo.confirmRemoveTitle")}
                      trigger={
                        <IconButton
                          icon="delete"
                          label={t("discovery.repoManager.removeAria", { repo: key })}
                          onClick={() => setPendingRemoval(view)}
                        />
                      }
                      variant="primary"
                    />
                  </div>
                </article>
              </li>
            );
          })}
          </ul>
        </div>
      )}
    </PageFrame>
  );
}
