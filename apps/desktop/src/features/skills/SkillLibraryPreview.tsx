import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { BootstrapSnapshot } from "../../api/bindings";
import { AppShell } from "../../app/AppShell";
import { useAppNotifications } from "../../ui/notifications";
import { createPreviewSecurityFacade } from "../security/previewFacade";
import { DEFAULT_DRAWER_PREFERENCES } from "./api";
import { drawerWidthForPreset } from "./drawerModules";
import { SkillLibraryPage } from "./SkillLibraryPage";
import { createMockSkillLibraryFacade } from "./testFixtures";

const PREVIEW_BOOTSTRAP_SNAPSHOT: BootstrapSnapshot = {
  initialization_state: "initialized",
  library_path: "C:\\Users\\preview\\SkillHub",
  onboarding_skipped: false,
  agent_count: 2,
  discovered_agent_count: 2,
  deployed_count: 12,
  deployment_categories: [],
  tag_categories: [],
  last_scan_at: null,
  pending: { by_kind: {}, total: 0 },
  project_count: 6,
  recent_operations: [],
  recovery_state: "clean",
  skill_count: 80,
};

export function SkillLibraryPreview() {
  const search = new URLSearchParams(window.location.search);
  const drawerSample = search.get("drawerSample");
  const [securityFacade] = useState(() => createPreviewSecurityFacade());
  const [facade] = useState(() => {
    const previewFacade = createMockSkillLibraryFacade({ total: previewTotal() });
    previewFacade.loadDrawerPreferences = async () => ({
      ...DEFAULT_DRAWER_PREFERENCES,
      preset: "standard",
      widthPx: drawerWidthForPreset("standard", window.innerWidth),
    });
    // 抽屉深链上下文（?skill=…）：按真实契约补齐 W3-6 物化根路径与 W3-7
    // 组合清单，让快捷抽屉的主体位置/所属组合模块可交互；无参预览保持
    // 精简列表，不影响库页其他预览场景。
    if (search.get("skill")) {
      const seededQuickView = previewFacade.getSkillQuickView.bind(previewFacade);
      previewFacade.getSkillQuickView = async (skillId) => {
        const view = await seededQuickView(skillId);
        return {
          ...view,
          rootPath: `C:\\preview\\SkillHub\\skills\\${view.originalName ?? skillId}`,
        };
      };
      const combinations = [
        { name: "文档工具", members: ["skill-pdf", "skill-docx"] },
        { name: "PDF 工作流", members: ["skill-pdf"] },
        { name: "研发工具", members: ["skill-docx"] },
      ];
      previewFacade.listCombinations = async () =>
        combinations.map((combination) => ({ ...combination, members: [...combination.members] }));
      previewFacade.updateCombination = async (name, members) => {
        const existing = combinations.find((combination) => combination.name === name);
        if (existing) existing.members = [...members];
        else combinations.push({ name, members: [...members] });
      };
    }
    if (drawerSample === "overflow") {
      const getQuickView = previewFacade.getSkillQuickView.bind(previewFacade);
      previewFacade.getSkillQuickView = async (skillId) => {
        const view = await getQuickView(skillId);
        const knownAgents = view.agentDeployments ?? [];
        const agents = Array.from({ length: 12 }, (_, index) => {
          const base = knownAgents[index % knownAgents.length] ?? knownAgents[0];
          return { ...base, id: `preview-agent-${index + 1}`, name: `${base?.name ?? "Preview Agent"} ${index + 1}` };
        });
        const projects = Array.from({ length: 12 }, (_, index) => ({
          id: `preview-project-${index + 1}`,
          name: `Preview project ${index + 1}`,
          path: `C:\\workspace\\preview\\project-${index + 1}`,
        }));
        return {
          ...view,
          agentDeploymentCount: agents.length,
          agentDeployments: agents,
          projectDeploymentCount: projects.length,
          projectDeployments: projects,
          tags: [
            "documents",
            "pdf",
            "multi-purpose-long-tag-for-overflow-review",
            "format-conversion",
            "local-processing",
            "preview-only",
            "metadata-extraction",
            "multi-language-support",
          ],
        };
      };
    }
    if (drawerSample !== "translation-unconfigured") {
      previewFacade.translateDescription = async (skillId) => {
        const view = await previewFacade.getSkillQuickView(skillId);
        return { text: view.translatedDescription ?? view.originalDescription ?? "" };
      };
    }
    return previewFacade;
  });
  const showNotificationPreview = new URLSearchParams(window.location.search)
    .has("notificationActions");
  return (
    <>
      {showNotificationPreview ? <NotificationActionPreview /> : null}
      <SkillLibraryPage
        facade={facade}
        securityFacade={securityFacade}
      />
    </>
  );
}

function NotificationActionPreview() {
  const { notify } = useAppNotifications();
  return (
    <button
      className="sh-button sh-button--secondary"
      onClick={() => {
        notify({
          source: "library",
          tone: "success",
          title: "Skill library refreshed",
          detail: "The central library is ready to review.",
          action: { label: "Open library", to: "/library" },
        });
        notify({
          source: "discovery",
          tone: "info",
          title: "New Agents were detected",
          detail: "Review the newly available Agent destinations.",
          action: { label: "Review Agents", to: "/agents" },
        });
      }}
      type="button"
    >
      Create action notifications
    </button>
  );
}

/** DEV-only harness knob: ?total=N seeds a deterministic N-skill catalog for scale checks. */
function previewTotal(): number {
  const raw = new URLSearchParams(window.location.search).get("total");
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 80;
}

export function SkillLibraryPreviewShell() {
  const [previewQueryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          mutations: { retry: false },
          queries: { refetchOnWindowFocus: false, retry: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={previewQueryClient}>
      <AppShell
        refreshSnapshot={async () => undefined}
        snapshot={PREVIEW_BOOTSTRAP_SNAPSHOT}
        verification={{ kind: "unavailable" }}
      />
    </QueryClientProvider>
  );
}
