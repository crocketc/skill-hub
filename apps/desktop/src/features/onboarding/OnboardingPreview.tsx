import { useMemo } from "react";
import { useParams } from "react-router-dom";
import type { ScanResult } from "../../api/bindings";
import { useTheme } from "../../styles/ThemeProvider";
import type { CompatibilityTarget, OnboardingOperations } from "../bootstrap/api";
import { OnboardingWizard } from "./OnboardingWizard";
import { RescanWizard } from "./RescanWizard";

const PREVIEW_LIBRARY_PATH = "C:\\Users\\Preview\\SkillHub\\skills";
// Long Windows path with deep segments: exercises wrapping without overflow.
const PREVIEW_LONG_LIBRARY_PATH = [
  "D:\\very-long-library-root-segment\\skillhub-central-library",
  "team-workspaces\\agent-platform\\imports-2026\\rediscovery-preview",
  "nested\\library-root",
].join("\\");

const PREVIEW_TARGETS: CompatibilityTarget[] = [
  { id: "preview-codex", label: "Codex", profileId: "openai", kind: "cli", availability: "available" },
  { id: "preview-claude", label: "Claude Code", profileId: "anthropic", kind: "cli", availability: "available" },
  { id: "preview-missing", label: "Missing Agent", kind: "desktop", availability: "unavailable" },
];

function previewScanResult(discoveredCount: number, root: string): ScanResult {
  const discovered = Array.from({ length: discoveredCount }, (_, index) => ({
    root,
    relative_path: `preview-skill-${String(index + 1).padStart(2, "0")}`,
    path: `${root}\\preview-skill-${String(index + 1).padStart(2, "0")}`,
    marker: "SKILL.md",
    marker_size: 12,
    marker_modified_at: 1,
    size: 12,
    latest_modified_at: 1,
    fingerprint: `f-${index}`,
    metadata_fingerprint: `m-${index}`,
  }));
  return {
    generation: { generation: 1, observed_at: 1 },
    roots: [root],
    discovered,
    visited_paths: [root, ...discovered.map((skill) => skill.path)],
    reparsed_count: discovered.length,
    unchanged_count: 0,
    errors:
      discoveredCount > 1
        ? [{ path: `${root}\\broken`, code: "permission_denied" }]
        : [],
  };
}

const PREVIEW_UNUSED_RUNTIME_ERROR = "unused in preview";

/**
 * DEV-only onboarding preview (/__preview/onboarding/:scenario).
 * Deterministic fake seams put every business branch on screen without
 * native, network or disk access: create, restore with a conflict,
 * rediscovery with 60+ discovered entries, failure/retry, slow scan with
 * background hand-off, and the unavailable-path state.
 */
export function OnboardingPreview() {
  const { scenario = "create" } = useParams<{ scenario: string }>();
  const { resolvedTheme, setAppearance } = useTheme();

  const previewOperations = useMemo<OnboardingOperations>(
    () => ({
      completeOnboarding: async () => undefined,
      discoverAgents: async () => ({ targets: PREVIEW_TARGETS }),
      pickDirectory: async () => `${PREVIEW_LIBRARY_PATH}\\custom`,
      activateLibraryRoot: async () => undefined,
    }),
    [],
  );

  if (scenario === "unavailable") {
    return (
      <OnboardingWizard
        initialBranch="create"
        onThemeChange={setAppearance}
        operations={{
          completeOnboarding: async () => undefined,
          discoverAgents: async () => ({ targets: [] }),
        }}
        theme={resolvedTheme}
      />
    );
  }

  if (scenario === "restore") {
    return (
      <OnboardingWizard
        initialBranch="restore"
        libraryPath={PREVIEW_LIBRARY_PATH}
        onThemeChange={setAppearance}
        operations={{
          completeOnboarding: async () => undefined,
          discoverAgents: async () => ({ targets: [] }),
          pickDirectory: async () => "C:\\backups\\preview.skillhub",
          prepareInitialRestore: async () => ({
            format_version: 1,
            skills: 2,
            deployments_requiring_rediscovery: 0,
            conflicts: [
              { skill_id: "preview-skill", kind: "existing_skill", detail: "Already exists" },
            ],
          }),
          commitInitialRestore: async () => ({
            skills_restored: 2,
            skills_skipped: 0,
            deployments_requiring_rediscovery: 0,
          }),
        }}
        theme={resolvedTheme}
      />
    );
  }

  if (scenario === "rescan" || scenario === "rescan-failures") {
    const failFirst = scenario === "rescan-failures";
    let discoverCalls = 0;
    let scanCalls = 0;
    return (
      <RescanWizard
        libraryPath={PREVIEW_LONG_LIBRARY_PATH}
        onCancel={() => undefined}
        onComplete={() => undefined}
        onOpenImport={() => undefined}
        operations={{
          completeOnboarding: async () => undefined,
          discoverAgents: async () => {
            discoverCalls += 1;
            if (failFirst && discoverCalls === 1) {
              throw { code: "preview.discovery_failed", severity: "error", params: {}, actions: [] };
            }
            return { targets: PREVIEW_TARGETS };
          },
        }}
        runtime={{
          getBootstrapView: async () => {
            throw new Error(PREVIEW_UNUSED_RUNTIME_ERROR);
          },
          runInitializationScan: async () => {
            scanCalls += 1;
            if (failFirst && scanCalls === 1) {
              throw { code: "preview.scan_failed", severity: "error", params: {}, actions: [] };
            }
            return {
              kind: "completed" as const,
              result: previewScanResult(60, "C:\\Users\\Preview\\.codex\\skills"),
            };
          },
        }}
      />
    );
  }

  if (scenario === "slow-scan") {
    return (
      <OnboardingWizard
        initialBranch="create"
        libraryPath={PREVIEW_LIBRARY_PATH}
        onThemeChange={setAppearance}
        operations={previewOperations}
        runtime={{
          getBootstrapView: async () => {
            throw new Error(PREVIEW_UNUSED_RUNTIME_ERROR);
          },
          runInitializationScan: () => new Promise(() => undefined),
        }}
        scanSlowAfterMs={200}
        theme={resolvedTheme}
      />
    );
  }

  return (
    <OnboardingWizard
      initialBranch={scenario === "branches" ? "select" : "create"}
      libraryPath={PREVIEW_LIBRARY_PATH}
      onThemeChange={setAppearance}
      operations={previewOperations}
      runtime={{
        getBootstrapView: async () => {
          throw new Error(PREVIEW_UNUSED_RUNTIME_ERROR);
        },
        runInitializationScan: async () => ({
          kind: "completed" as const,
          result: previewScanResult(2, "C:\\Users\\Preview\\.codex\\skills"),
        }),
      }}
      theme={resolvedTheme}
    />
  );
}
