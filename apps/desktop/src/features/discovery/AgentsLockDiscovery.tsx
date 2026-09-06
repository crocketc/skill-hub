import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { AgentsLockEntry, DiscoverableRepoSkill } from "../../api/bindings";

export interface AgentsLockFacade {
  discoverAgentsLockSkills: () => Promise<AgentsLockEntry[]>;
  downloadRepoSkill: (skill: DiscoverableRepoSkill) => Promise<{ local_path: string; runtime_name: string }>;
}

export interface AgentsLockDiscoveryProps {
  facade: AgentsLockFacade;
  /** Called with the downloaded local directory so it enters the import wizard. */
  onImportDirectory: (directory: string) => void;
}

interface LockRow {
  entry: AgentsLockEntry;
  skill: DiscoverableRepoSkill;
}

/**
 * Q17：`~/.agents/.skill-lock.json` 发现（只读）。列出其中 GitHub 来源的
 * Skill 条目；"下载并导入"复用既有仓库下载（预算受限）并进入导入向导。
 * lock 文件缺失或为空时如实显示空态。
 */
export function AgentsLockDiscovery({ facade, onImportDirectory }: AgentsLockDiscoveryProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<AgentsLockEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [downloadingName, setDownloadingName] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      setEntries(await facade.discoverAgentsLockSkills());
    } catch {
      setError(t("discovery.agentsLock.failed"));
    } finally {
      setScanning(false);
    }
  }, [facade, t]);

  const toRepoSkill = (entry: AgentsLockEntry): DiscoverableRepoSkill => ({
    key: `${entry.owner}/${entry.repo}:${entry.skill_path ?? ""}`,
    name: entry.name,
    description: "",
    directory: entry.skill_path ?? "",
    readme_url: null,
    repo_owner: entry.owner,
    repo_name: entry.repo,
    // 空分支是宿主的"默认分支回退"哨兵（main → master）
    repo_branch: entry.branch ?? "",
  });

  const downloadAndImport = useCallback(
    async (row: LockRow) => {
      setDownloadingName(row.entry.name);
      setError(null);
      try {
        const downloaded = await facade.downloadRepoSkill(row.skill);
        onImportDirectory(downloaded.local_path);
      } catch {
        setError(t("discovery.agentsLock.downloadFailed"));
      } finally {
        setDownloadingName(null);
      }
    },
    [facade, onImportDirectory, t],
  );

  return (
    <article aria-label={t("discovery.agentsLock.title")} className="sh-discovery-card">
      <div className="sh-discovery-card__heading">
        <div>
          <p className="sh-discovery-card__eyebrow">{t("discovery.agentsLock.eyebrow")}</p>
          <h2>{t("discovery.agentsLock.title")}</h2>
        </div>
        <span aria-hidden="true" className="sh-discovery-card__icon">⇣</span>
      </div>
      <p>{t("discovery.agentsLock.description")}</p>
      <div className="sh-discovery-card__search">
        <Button disabled={scanning} onClick={() => void scan()} variant="secondary">
          {scanning ? t("discovery.agentsLock.scanning") : t("discovery.agentsLock.scan")}
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {entries ? (
        entries.length === 0 ? (
          <p>{t("discovery.agentsLock.empty")}</p>
        ) : (
          <ul className="sh-discovery-card__results">
            {entries.map((entry) => {
              const row: LockRow = { entry, skill: toRepoSkill(entry) };
              return (
                <li key={`${entry.owner}/${entry.repo}/${entry.name}`}>
                  <span>{entry.name}</span>
                  <span>
                    {t("discovery.agentsLock.source", {
                      repo: `${entry.owner}/${entry.repo}`,
                      branch: entry.branch ?? t("discovery.agentsLock.defaultBranch"),
                    })}
                  </span>
                  {entry.skill_path ? (
                    <span>{t("discovery.agentsLock.skillPath", { path: entry.skill_path })}</span>
                  ) : null}
                  <Button
                    disabled={downloadingName !== null}
                    onClick={() => void downloadAndImport(row)}
                    variant="secondary"
                  >
                    {downloadingName === entry.name
                      ? t("discovery.agentsLock.downloading")
                      : t("discovery.agentsLock.downloadImport")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </article>
  );
}
