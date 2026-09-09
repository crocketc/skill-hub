import { type DownloadedRepoSkill, type SourceSearchPage } from "../../api/bindings";
import { OnlineDiscovery } from "./OnlineDiscovery";
import type { DiscoveryFacade } from "./api";

const PLAIN_PAGE: SourceSearchPage = {
  items: [
    {
      source_id: "skills.sh/anthropics/skills/pdf",
      name: "PDF Reader",
      source: { kind: "https", locator: { https_url: "https://github.com/anthropics/skills/tree/main/pdf" } },
      install_url: null,
      page_url: "https://skills.sh/anthropics/skills/pdf",
      installs: 42,
      is_duplicate: false,
    },
  ],
  query: "pdf",
  count: 1,
  search_type: "skills",
  duration_ms: 12,
  cache_max_age_seconds: null,
};

const ASSISTED_PAGE: SourceSearchPage = {
  items: [
    ...PLAIN_PAGE.items,
    {
      source_id: "skills.sh/community/pdf-tools",
      name: "PDF Toolkit",
      source: { kind: "https", locator: { https_url: "https://github.com/community/pdf-tools" } },
      install_url: null,
      page_url: "https://skills.sh/community/pdf-tools",
      installs: 7,
      is_duplicate: false,
      via: "expanded_query",
    },
  ],
  query: "pdf",
  count: 2,
  search_type: "skills",
  duration_ms: 40,
  cache_max_age_seconds: null,
  ai_assisted: true,
  expanded_query: "pdf extraction tables",
};

/**
 * DEV-only preview for the AI-assisted online search loop: the fake facade
 * returns a plain page for the base search and an AI-extended page when the
 * assist toggle is on, so the E2E covers trigger, marking and the notice
 * without touching the network.
 */
export function OnlineDiscoveryPreview() {
  const facade: DiscoveryFacade = {
    async getDiscoverySnapshot() {
      throw new Error("preview keeps to the online workbench");
    },
    async scanTargets() {
      throw new Error("preview keeps to the online workbench");
    },
    async searchOnlineSources() {
      return PLAIN_PAGE;
    },
    async searchOnlineSourcesAssisted() {
      return ASSISTED_PAGE;
    },
    async listSkillRepos() {
      return [];
    },
    async discoverRepoSkills() {
      return { skills: [], warnings: [] };
    },
    async discoverAgentsLockSkills() {
      return [];
    },
    async addSkillRepo() {
      return [];
    },
    async removeSkillRepo() {
      return [];
    },
    async downloadRepoSkill(skill): Promise<DownloadedRepoSkill> {
      return { local_path: `C:/temp/skillhub-repo-skills/preview/${skill.repo_name}`, runtime_name: "pdf" };
    },
    async openExternalUrl() {},
  };
  return (
    <main className="sh-page">
      <OnlineDiscovery
        facade={facade}
        onImportDirectory={() => undefined}
        onStartImport={() => undefined}
      />
    </main>
  );
}
