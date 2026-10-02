import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { BootstrapSnapshot } from "../../api/bindings";
import { AppShell } from "../../app/AppShell";
import { useAppNotifications } from "../../ui/notifications";
import { createPreviewSecurityFacade } from "../security/previewFacade";
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
  const [securityFacade] = useState(() => createPreviewSecurityFacade());
  const [facade] = useState(() => {
    const previewFacade = createMockSkillLibraryFacade({ total: previewTotal() });
    previewFacade.listCombinations = async () => [];
    return previewFacade;
  });
  const showNotificationPreview = new URLSearchParams(window.location.search)
    .has("notificationActions");
  return (
    <>
      {showNotificationPreview ? <NotificationActionPreview /> : null}
      <SkillLibraryPage facade={facade} securityFacade={securityFacade} />
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
