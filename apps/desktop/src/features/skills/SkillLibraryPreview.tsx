import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { BootstrapSnapshot } from "../../api/bindings";
import { AppShell } from "../../app/AppShell";
import { SkillLibraryPage } from "./SkillLibraryPage";
import { createMockSkillLibraryFacade } from "./testFixtures";

const PREVIEW_BOOTSTRAP_SNAPSHOT: BootstrapSnapshot = {
  initialization_state: "initialized",
  library_path: "C:\\Users\\preview\\SkillHub",
  onboarding_skipped: false,
  agent_count: 2,
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
  const [facade] = useState(() => createMockSkillLibraryFacade({ total: 80 }));
  return <SkillLibraryPage facade={facade} />;
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
        snapshot={PREVIEW_BOOTSTRAP_SNAPSHOT}
        verification={{ kind: "unavailable" }}
      />
    </QueryClientProvider>
  );
}
