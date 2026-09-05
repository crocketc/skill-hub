import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import type { DiscoverableRepoSkill, SkillRepo } from "../../api/bindings";
import type { DiscoveryFacade } from "./api";

export interface RepoDiscoveryProps {
  facade: DiscoveryFacade;
  /** Called with the downloaded local directory so it enters the import wizard. */
  onImportDirectory: (directory: string) => void;
}

/**
 * FE-07 仓库发现：管理 GitHub 仓库列表（CRUD + 启用开关），下载仓库归档
 * 扫描 SKILL.md 生成可导入列表。下载只写入本机临时目录；导入必须经用户
 * 显式进入既有导入向导完成。单仓库失败仅告警，不拖垮整体。
 */
export function RepoDiscovery({ facade, onImportDirectory }: RepoDiscoveryProps) {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<SkillRepo[]>([]);
  const [reposLoaded, setReposLoaded] = useState(false);
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [report, setReport] = useState<{
    skills: DiscoverableRepoSkill[];
    warnings: { owner: string; name: string; reason: string }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<SkillRepo | null>(null);

  useEffect(() => {
    let cancelled = false;
    facade
      .listSkillRepos()
      .then((result) => {
        if (cancelled) return;
        setRepos(result);
        setReposLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setError(t("discovery.repo.failed"));
      });
    return () => {
      cancelled = true;
    };
  }, [facade, t]);

  const discover = useCallback(async () => {
    setDiscovering(true);
    setError(null);
    try {
      const result = await facade.discoverRepoSkills();
      setReport({ skills: result.skills, warnings: result.warnings });
    } catch {
      setError(t("discovery.repo.failed"));
    } finally {
      setDiscovering(false);
    }
  }, [facade, t]);

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
    } catch {
      setError(t("discovery.repo.failed"));
    }
  }, [branch, facade, name, owner, t]);

  const toggleRepo = useCallback(
    async (repo: SkillRepo) => {
      setError(null);
      try {
        const updated = await facade.addSkillRepo({ ...repo, enabled: !repo.enabled });
        setRepos(updated);
      } catch {
        setError(t("discovery.repo.failed"));
      }
    },
    [facade, t],
  );

  const removeRepo = useCallback(async () => {
    if (!pendingRemoval) return;
    setError(null);
    try {
      const updated = await facade.removeSkillRepo(pendingRemoval.owner, pendingRemoval.name);
      setRepos(updated);
      setReport((current) =>
        current
          ? {
              skills: current.skills.filter(
                (skill) =>
                  !(
                    skill.repo_owner === pendingRemoval.owner &&
                    skill.repo_name === pendingRemoval.name
                  ),
              ),
              warnings: current.warnings.filter(
                (warning) =>
                  !(warning.owner === pendingRemoval.owner && warning.name === pendingRemoval.name),
              ),
            }
          : current,
      );
    } catch {
      setError(t("discovery.repo.failed"));
    } finally {
      setPendingRemoval(null);
    }
  }, [facade, pendingRemoval, t]);

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

  return (
    <article aria-label={t("discovery.repo.title")} className="sh-discovery-card">
      <div className="sh-discovery-card__heading">
        <div>
          <p className="sh-discovery-card__eyebrow">{t("discovery.repo.eyebrow")}</p>
          <h2>{t("discovery.repo.title")}</h2>
        </div>
        <span aria-hidden="true" className="sh-discovery-card__icon">⭳</span>
      </div>
      <p>{t("discovery.repo.description")}</p>

      <ul className="sh-discovery-card__results">
        {repos.map((repo) => (
          <li key={`${repo.owner}/${repo.name}`}>
            <label>
              <input
                checked={repo.enabled}
                onChange={() => void toggleRepo(repo)}
                type="checkbox"
                aria-label={t("discovery.repo.enabled")}
              />
              <span>{`${repo.owner}/${repo.name}@${repo.branch}`}</span>
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
                  onClick={() => setPendingRemoval(repo)}
                  variant="ghost"
                >
                  {t("discovery.repo.remove")}
                </Button>
              }
              variant="primary"
            />
          </li>
        ))}
        {reposLoaded && repos.length === 0 ? (
          <li>{t("discovery.repo.empty")}</li>
        ) : null}
      </ul>

      <div className="sh-discovery-card__search">
        <input
          aria-label={t("discovery.repo.owner")}
          onChange={(event) => setOwner(event.target.value)}
          placeholder={t("discovery.repo.owner")}
          type="text"
          value={owner}
        />
        <input
          aria-label={t("discovery.repo.name")}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("discovery.repo.name")}
          type="text"
          value={name}
        />
        <input
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
      </div>

      {error ? <p role="alert">{error}</p> : null}

      {report ? (
        <>
          {report.warnings.length > 0 ? (
            <ul>
              {report.warnings.map((warning) => (
                <li key={`${warning.owner}/${warning.name}`}>
                  {t("discovery.repo.warning", {
                    repo: `${warning.owner}/${warning.name}`,
                    reason: warning.reason,
                  })}
                </li>
              ))}
            </ul>
          ) : null}
          {report.skills.length === 0 ? <p>{t("discovery.repo.noResults")}</p> : null}
          <ul className="sh-discovery-card__results">
            {report.skills.map((skill) => (
              <li key={skill.key}>
                <span>{skill.name}</span>
                <span>{skill.description}</span>
                <span>{`${skill.repo_owner}/${skill.repo_name}@${skill.repo_branch}`}</span>
                {skill.readme_url ? (
                  <a href={skill.readme_url} rel="noreferrer" target="_blank" title={skill.readme_url}>
                    README
                  </a>
                ) : null}
                <Button
                  disabled={downloadingKey !== null}
                  onClick={() => void downloadAndImport(skill)}
                  variant="secondary"
                >
                  {downloadingKey === skill.key
                    ? t("discovery.repo.downloading")
                    : t("discovery.repo.downloadImport")}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </article>
  );
}
