import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Icon } from "../../ui/Icon";
import { Input } from "../../ui/Input";
import { ExternalLink } from "../markdown/ExternalLink";
import { SkillCard } from "../shared/skill-card/SkillCard";
import type { SkillCardViewModel } from "../shared/skill-card/SkillCardViewModel";
import type { DiscoverableRepoSkill, SkillRepoView } from "../../api/bindings";
import { describeRepoWarning } from "./api";
import type { DiscoveryFacade } from "./api";

export interface RepoDiscoveryProps {
  facade: DiscoveryFacade;
  /** Called with the downloaded local directory so it enters the import wizard. */
  onImportDirectory: (directory: string) => void;
}

// 失败原因分类文案已上移至 ./api（与 D4 仓库管理页共用）；此处保留导出，
// 让既有调用方（含测试）的导入路径保持稳定。
export { describeRepoWarning };

/**
 * FE-07 仓库发现：管理 GitHub 仓库列表（CRUD + 启用开关），下载仓库归档
 * 扫描 SKILL.md 生成可导入列表。下载只写入本机临时目录；导入必须经用户
 * 显式进入既有导入向导完成。单仓库失败仅告警，不拖垮整体。
 */
export function RepoDiscovery({ facade, onImportDirectory }: RepoDiscoveryProps) {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<SkillRepoView[]>([]);
  const [reposLoaded, setReposLoaded] = useState(false);
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [report, setReport] = useState<{
    skills: DiscoverableRepoSkill[];
    warnings: { owner: string; name: string; reason: string }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<SkillRepoView | null>(null);
  // P1-04：逐仓重试进行中的 key（owner/name）。
  const [retryingKey, setRetryingKey] = useState<string | null>(null);

  // describeNativeError 以动态键调用翻译；i18next 的强类型键联合在此收窄。
  const describe = useCallback(
    (scanError: unknown) =>
      describeNativeError(
        scanError,
        (key, options) => String(t(key as never, options as never)),
        "discovery.repo.failedGeneric",
      ),
    [t],
  );

  // AR-011：扫描期间诚实显示已用时秒数，让用户能区分“进行中”与“卡住”。
  useEffect(() => {
    if (!discovering) return;
    setElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setElapsedSeconds((current) => current + 1);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [discovering]);

  useEffect(() => {
    let cancelled = false;
    facade
      .listSkillRepos()
      .then((result) => {
        if (cancelled) return;
        setRepos(result);
        setReposLoaded(true);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(describe(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [describe, facade]);

  const discover = useCallback(async () => {
    setDiscovering(true);
    setError(null);
    try {
      const result = await facade.discoverRepoSkills();
      setReport({ skills: result.skills, warnings: result.warnings });
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setDiscovering(false);
    }
  }, [describe, facade]);

  // P1-04：逐仓重试——复用整体发现查询（仓库列表小，成本可接受），
  // 但只替换该仓库的 skills/warnings 行，不影响其他仓库的展示。
  const retryRepo = useCallback(
    async (warning: { owner: string; name: string; reason: string }) => {
      const key = `${warning.owner}/${warning.name}`;
      setRetryingKey(key);
      setError(null);
      try {
        const result = await facade.discoverRepoSkills();
        setReport((current) => current
          ? {
              skills: [
                ...current.skills.filter(
                  (entry) => !(entry.repo_owner === warning.owner && entry.repo_name === warning.name),
                ),
                ...result.skills.filter(
                  (entry) => entry.repo_owner === warning.owner && entry.repo_name === warning.name,
                ),
              ],
              warnings: [
                ...current.warnings.filter(
                  (entry) => !(entry.owner === warning.owner && entry.name === warning.name),
                ),
                ...result.warnings.filter(
                  (entry) => entry.owner === warning.owner && entry.name === warning.name,
                ),
              ],
            }
          : current);
      } catch (reason) {
        setError(describe(reason));
      } finally {
        setRetryingKey(null);
      }
    },
    [describe, facade],
  );

  const addRepo = useCallback(async () => {
    if (!owner.trim() || !name.trim()) return;
    setError(null);
    try {
      const updated = await facade.addSkillRepo({
        owner: owner.trim(),
        name: name.trim(),
        branch: branch.trim(),
        enabled: true,
      });
      setRepos(updated);
      setOwner("");
      setName("");
      setBranch("");
    } catch (reason) {
      setError(describe(reason));
    }
  }, [branch, describe, facade, name, owner]);

  const toggleRepo = useCallback(
    async (view: SkillRepoView) => {
      setError(null);
      try {
        const updated = await facade.addSkillRepo({
          ...view.repo,
          enabled: !view.repo.enabled,
        });
        setRepos(updated);
      } catch (reason) {
        setError(describe(reason));
      }
    },
    [describe, facade],
  );

  const removeRepo = useCallback(async () => {
    if (!pendingRemoval) return;
    setError(null);
    try {
      const removed = pendingRemoval.repo;
      const updated = await facade.removeSkillRepo(removed.owner, removed.name);
      setRepos(updated);
      setReport((current) =>
        current
          ? {
              skills: current.skills.filter(
                (skill) =>
                  !(skill.repo_owner === removed.owner && skill.repo_name === removed.name),
              ),
              warnings: current.warnings.filter(
                (warning) =>
                  !(warning.owner === removed.owner && warning.name === removed.name),
              ),
            }
          : current,
      );
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setPendingRemoval(null);
    }
  }, [describe, facade, pendingRemoval]);

  const downloadAndImport = useCallback(
    async (skill: DiscoverableRepoSkill) => {
      const key = skill.key;
      setDownloadingKey(key);
      setError(null);
      try {
        const downloaded = await facade.downloadRepoSkill(skill);
        onImportDirectory(downloaded.local_path);
      } catch {
        setError(t("discovery.repo.downloadFailed"));
      } finally {
        setDownloadingKey(null);
      }
    },
    [facade, onImportDirectory, t],
  );

  // 仓库归档缺少的字段（如空描述）如实省略，不伪造卡片内容。
  const toCard = (skill: DiscoverableRepoSkill): SkillCardViewModel => ({
    id: skill.key,
    name: skill.name,
    sourceType: "repo",
    sourceLabel: `${skill.repo_owner}/${skill.repo_name}@${skill.repo_branch}`,
    description: skill.description || undefined,
    location: skill.directory || undefined,
    sourceAddress: skill.readme_url ?? undefined,
  });

  return (
    <section aria-label={t("discovery.repo.title")} className="sh-discovery-module">
      <header className="sh-discovery-module__heading">
        <div>
          <p className="sh-discovery-module__eyebrow">{t("discovery.repo.eyebrow")}</p>
          <h2>{t("discovery.repo.title")}</h2>
        </div>
        <span aria-hidden="true" className="sh-discovery-module__icon">
          <Icon name="import" size={24} />
        </span>
      </header>
      <p className="sh-discovery-module__description">{t("discovery.repo.description")}</p>

      {/* D4：仓库管理独立页入口；本区保留扫描与结果展示能力不撤。 */}
      <div className="sh-discovery-module__manage">
        <Link className="sh-button sh-button--secondary sh-button--sm" to="/discovery/repositories">
          {t("discovery.repo.manage")}
        </Link>
      </div>

      <div className="sh-discovery-module__body">
        <ul className="sh-discovery-repos">
          {repos.map((view) => {
            const repo = view.repo;
            return (
              <li className="sh-discovery-repos__repo" key={`${repo.owner}/${repo.name}`}>
                <label className="sh-discovery-repos__toggle">
                  <input
                    checked={repo.enabled}
                    onChange={() => void toggleRepo(view)}
                    type="checkbox"
                    aria-label={t("discovery.repo.enabled")}
                  />
                  <span className="sh-discovery-repos__name">{`${repo.owner}/${repo.name}@${repo.branch}`}</span>
                </label>
                <ConfirmDialog
                  cancelLabel={t("actions.cancel")}
                  confirmLabel={t("discovery.repo.confirmRemove")}
                  description={t("discovery.repo.confirmRemoveDescription", {
                    repo: `${repo.owner}/${repo.name}`,
                  })}
                  onConfirm={() => void removeRepo()}
                  title={t("discovery.repo.confirmRemoveTitle")}
                  trigger={
                    <Button
                      onClick={() => setPendingRemoval(view)}
                      variant="ghost"
                    >
                      {t("discovery.repo.remove")}
                    </Button>
                  }
                  variant="primary"
                />
              </li>
            );
          })}
          {reposLoaded && repos.length === 0 ? (
            <li>{t("discovery.repo.empty")}</li>
          ) : null}
        </ul>

        <div className="sh-discovery-module__controls">
          <Input
            aria-label={t("discovery.repo.owner")}
            onChange={(event) => setOwner(event.target.value)}
            placeholder={t("discovery.repo.owner")}
            type="text"
            value={owner}
          />
          <Input
            aria-label={t("discovery.repo.name")}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("discovery.repo.name")}
            type="text"
            value={name}
          />
          <Input
            aria-label={t("discovery.repo.branch")}
            onChange={(event) => setBranch(event.target.value)}
            placeholder={t("discovery.repo.branch")}
            type="text"
            value={branch}
          />
          <Button disabled={!owner.trim() || !name.trim()} onClick={() => void addRepo()} variant="secondary">
            {t("discovery.repo.add")}
          </Button>
          <Button disabled={discovering} onClick={() => void discover()} variant="secondary">
            {discovering ? t("discovery.repo.scanning") : t("discovery.repo.scan")}
          </Button>
          {discovering ? (
            <p aria-live="polite" role="status" className="sh-discovery-repos__scanning">
              {t("discovery.repo.scanningElapsed", { seconds: elapsedSeconds })}
              {" "}
              {t("discovery.repo.scanningHint")}
            </p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
        </div>

        {report ? (
          <>
            {report.warnings.length > 0 ? (
              <ul className="sh-discovery-repos__warnings">
                {report.warnings.map((warning) => {
                  const repoLabel = `${warning.owner}/${warning.name}`;
                  return (
                    <li key={repoLabel}>
                      <span>
                        <strong>{repoLabel}</strong>
                        {" "}
                        {describeRepoWarning(warning.reason, (key, options) =>
                          String(t(key as never, options as never)))}
                      </span>
                      <Button
                        aria-label={t("discovery.repo.retryAria", { repo: repoLabel })}
                        disabled={retryingKey !== null || discovering}
                        onClick={() => void retryRepo(warning)}
                        variant="secondary"
                      >
                        {retryingKey === repoLabel
                          ? t("discovery.repo.retrying")
                          : t("discovery.repo.retry")}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {report.skills.length === 0 ? <p>{t("discovery.repo.noResults")}</p> : null}
            <div className="sh-discovery-results-zone">
              <ul
                aria-label={t("discovery.repo.results")}
                className="sh-discovery-results"
              >
                {report.skills.map((skill) => (
                  <li key={skill.key}>
                    <SkillCard
                      primaryAction={
                        <Button
                          disabled={downloadingKey !== null}
                          onClick={() => void downloadAndImport(skill)}
                          variant="secondary"
                        >
                          {downloadingKey === skill.key
                            ? t("discovery.repo.downloading")
                            : t("discovery.repo.downloadImport")}
                        </Button>
                      }
                      secondaryAction={skill.readme_url ? (
                        <ExternalLink
                          onOpen={() => void facade.openExternalUrl(skill.readme_url as string)}
                          target={skill.readme_url}
                        >
                          README
                        </ExternalLink>
                      ) : undefined}
                      skill={toCard(skill)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
