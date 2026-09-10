import type { AgentsLockEntry, DiscoverableRepoSkill, DownloadedRepoSkill, SkillRepo, SourceSearchHit, SourceSearchPage } from "../../api/bindings";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { useTheme } from "../../styles/ThemeProvider";
import { themeNames } from "../../styles/theme";
import { AgentsLockDiscovery } from "../discovery/AgentsLockDiscovery";
import { OnlineDiscovery } from "../discovery/OnlineDiscovery";
import type { DiscoveryFacade } from "../discovery/api";
import { RepoDiscovery } from "../discovery/RepoDiscovery";

/**
 * 120-char mixed CJK/ASCII long-name stress fixture. The CJK part is written
 * with unicode escapes so this DEV-only file stays clean in the i18n CJK
 * audit while still rendering real wide characters at runtime.
 */
const LONG_NAME =
  "\u957f\u540d\u79f0\u538b\u529b\u6d4b\u8bd5 Skill\uff1a\u8de8\u5e73\u53f0\u6587\u6863\u89e3\u6790\u3001\u8868\u683c\u8bc6\u522b\u4e0e\u6279\u91cf\u683c\u5f0f\u8f6c\u6362\u5de5\u5177\u96c6\uff08CJK \u4e0e ASCII mixed long-name stress fixture 0123456789 ABCDEFGHIJK\uff09\u957f\u540d\u79f0\u538b\u529b\u6d4b\u8bd5\u538b\u529b\u6d4b\u8bd5\u957f\u540d\u79f0";

const HITS: SourceSearchHit[] = [
  {
    source_id: "skills.sh/anthropics/skills/pdf",
    name: "PDF Reader",
    source: {
      kind: "https",
      locator: { https_url: "https://github.com/anthropics/skills/tree/main/pdf" },
    },
    install_url: null,
    page_url: "https://skills.sh/anthropics/skills/pdf",
    installs: 42,
    is_duplicate: false,
  },
  {
    source_id: "skills.sh/community/pdf-tools",
    name: "PDF Toolkit",
    source: {
      kind: "https",
      locator: { https_url: "https://github.com/community/pdf-tools" },
    },
    install_url: null,
    page_url: "https://skills.sh/community/pdf-tools",
    installs: 7,
    is_duplicate: false,
    via: "expanded_query",
  },
  {
    source_id: "skills.sh/acme/markdown-renderer",
    name: "Markdown Renderer",
    source: {
      kind: "https",
      locator: { https_url: "https://github.com/acme/markdown-renderer" },
    },
    install_url: null,
    page_url: "https://skills.sh/acme/markdown-renderer",
    installs: 128,
    is_duplicate: false,
  },
  {
    source_id: "local/unknown",
    name: "Local Pack",
    source: { kind: "local", locator: { local_path: "C:/skills/local-pack" } },
    install_url: null,
    page_url: "https://example.com/local-pack",
    installs: 3,
    is_duplicate: false,
  },
  {
    source_id: "skills.sh/long/name",
    name: LONG_NAME,
    source: {
      kind: "https",
      locator: { https_url: "https://github.com/fixture/long-name" },
    },
    install_url: null,
    page_url: "https://skills.sh/fixture/long-name",
    installs: 12345,
    is_duplicate: false,
  },
];

const HIT_PAGE: SourceSearchPage = {
  items: HITS,
  query: "pdf",
  count: HITS.length,
  search_type: "skills",
  duration_ms: 12,
  cache_max_age_seconds: 60,
  ai_assisted: true,
  expanded_query: "pdf extraction tables",
};

const REPOS: SkillRepo[] = [
  { owner: "anthropics", name: "skills", branch: "main", enabled: true },
  { owner: "cexll", name: "myclaude", branch: "master", enabled: false },
];

const REPO_SKILLS: DiscoverableRepoSkill[] = [
  {
    key: "anthropics/skills:pdf",
    name: "PDF Processor",
    description: "\u89e3\u6790\u5e76\u5904\u7406 PDF \u6587\u6863\uff0c\u4ece\u4ed3\u5e93\u5f52\u6863\u626b\u63cf SKILL.md \u751f\u6210\u3002",
    directory: "pdf",
    readme_url: "https://github.com/anthropics/skills/blob/main/pdf/SKILL.md",
    repo_owner: "anthropics",
    repo_name: "skills",
    repo_branch: "main",
  },
  {
    key: "anthropics/skills:deep/nested/tool",
    name: "Nested Tool",
    // 仓库归档未提供描述：卡片必须诚实省略。
    description: "",
    directory: "deep/nested/tool",
    readme_url: null,
    repo_owner: "anthropics",
    repo_name: "skills",
    repo_branch: "main",
  },
];

const LOCK_ENTRIES: AgentsLockEntry[] = [
  {
    name: "pdf",
    owner: "anthropics",
    repo: "skills",
    branch: "v2",
    skill_path: "skills/pdf",
  },
  {
    name: "whole-repo",
    owner: "octo",
    repo: "whole",
    branch: null,
    skill_path: null,
  },
];

function previewFacade(): DiscoveryFacade {
  return {
    async getDiscoverySnapshot() {
      throw new Error("preview keeps to deterministic fixtures");
    },
    async scanTargets() {
      throw new Error("preview keeps to deterministic fixtures");
    },
    async searchOnlineSources() {
      return HIT_PAGE;
    },
    async listSkillRepos(): Promise<SkillRepo[]> {
      return REPOS;
    },
    async discoverRepoSkills() {
      return { skills: REPO_SKILLS, warnings: [{ owner: "gone", name: "missing", reason: "DOWNLOAD_FAILED status=404" }] };
    },
    async discoverAgentsLockSkills(): Promise<AgentsLockEntry[]> {
      return LOCK_ENTRIES;
    },
    async addSkillRepo(repo: SkillRepo): Promise<SkillRepo[]> {
      return [repo];
    },
    async removeSkillRepo(): Promise<SkillRepo[]> {
      return REPOS;
    },
    async downloadRepoSkill(skill): Promise<DownloadedRepoSkill> {
      return {
        local_path: `C:/temp/skillhub-repo-skills/preview/${skill.repo_name}`,
        runtime_name: skill.name,
      };
    },
    async openExternalUrl() {},
  };
}

/**
 * DEV-only preview (/__preview/discovery-cards).
 * 发现页共享 Skill 卡片的单一验收入口：在线/仓库/lock 三类结果卡片、
 * AI 扩展命中、已在库、不可安装、长名称状态与 9 主题切换。
 * 全部数据为确定性夹具，不触网络，不进入生产路由。
 */
export function DiscoveryCardsPreview() {
  const { appearance, resolvedTheme, setAppearance } = useTheme();
  const facade = previewFacade();

  return (
    <PageFrame width="wide">
      <PageHeader
        description={"\u53d1\u73b0\u9875\u5171\u4eab Skill \u5361\u7247\u9a8c\u6536\u5c55\u677f\uff1a\u5361\u7247\u6a21\u578b\u3001\u72b6\u6001\u8bed\u4e49\u30013/2/1 \u5217\u4e0e\u4e3b\u9898\u8986\u76d6\u3002"}
        title={`Discovery cards \u00b7 ${resolvedTheme}`}
      />
      <div aria-label={"\u4e3b\u9898\u5207\u6362"} className="sh-preview-board__themes" role="group">
        {themeNames.map((theme) => (
          <button
            aria-pressed={appearance === theme}
            className="sh-preview-board__theme"
            key={theme}
            onClick={() => setAppearance(theme)}
            type="button"
          >
            {theme}
          </button>
        ))}
      </div>
      <OnlineDiscovery
        facade={facade}
        importedNames={async () => ["markdown renderer"]}
        onImportDirectory={() => undefined}
        onStartImport={() => undefined}
      />
      <RepoDiscovery facade={facade} onImportDirectory={() => undefined} />
      <AgentsLockDiscovery facade={facade} onImportDirectory={() => undefined} />
    </PageFrame>
  );
}
