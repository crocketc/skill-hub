import { useState } from "react";
import {
  createMockImportFacade,
  unavailableImportFacade,
  type ImportAiPreCheckReport,
  type ImportCandidate,
  type ImportFacade,
  type MockImportFacade,
  type SourceDescriptor,
} from "./api";
import { ImportWizard } from "./ImportWizard";

/** 为 bulk 预览生成 60 个候选：名称、路径长度各异，覆盖 50+ 条目场景。 */
function bulkCandidates(source: SourceDescriptor): ImportCandidate[] {
  const ownerships = ["unknown", "managed", "agent_builtin", "plugin", "other_tool"] as const;
  const checks = ["passed", "not_checked", "failed"] as const;
  return Array.from({ length: 60 }, (_, index) => ({
    basicCheck: checks[index % checks.length],
    id: `bulk-${index + 1}`,
    name: `Preview Skill ${index + 1}`,
    ownership: ownerships[index % ownerships.length],
    path: index % 4 === 0
      ? `${source.displayTarget}/very-long-preview-directory-segment/preview-skill-${index + 1}`
      : `${source.displayTarget}/preview-skill-${index + 1}`,
    source,
  }));
}

type PreviewScenario =
  | "default"
  | "bulk"
  | "conflict"
  | "fail-acquire"
  | "cancel"
  | "onboarding"
  | "unavailable";

const scenarios: readonly PreviewScenario[] = [
  "default",
  "bulk",
  "conflict",
  "fail-acquire",
  "cancel",
  "onboarding",
  "unavailable",
];

function previewScenario(): PreviewScenario {
  const value = new URLSearchParams(window.location.search).get("scenario");
  return scenarios.find((candidate) => candidate === value) ?? "default";
}

interface PreviewSetup {
  facade: ImportFacade;
  initialSources: string[];
  variant: "onboarding" | "standard";
}

function createPreviewSetup(scenario: PreviewScenario): PreviewSetup {
  if (scenario === "unavailable") {
    return { facade: unavailableImportFacade, initialSources: [], variant: "standard" };
  }
  if (scenario === "cancel") {
    return {
      facade: createMockImportFacade({ scenario: "cancelled" }),
      initialSources: [],
      variant: "standard",
    };
  }
  if (scenario === "onboarding") {
    return {
      facade: createMockImportFacade({ scenario: "safe-local" }),
      initialSources: ["C:/codex/skills", "C:/claude/skills"],
      variant: "onboarding",
    };
  }
  const mock: MockImportFacade = createMockImportFacade({
    scenario: scenario === "conflict" ? "conflict-required" : "safe-local",
  });
  let facade: ImportFacade = mock;
  if (scenario === "bulk") {
    facade = {
      ...mock,
      async acquireCandidates(source) {
        mock.calls.acquiredSources.push(source.displayTarget);
        return bulkCandidates(source);
      },
    };
  }
  if (scenario === "fail-acquire") {
    facade = {
      ...mock,
      async acquireCandidates() {
        throw new Error("preview.acquire_failed");
      },
    };
  }
  return {
    facade: {
      ...facade,
      async runAiPreChecks(plan): Promise<ImportAiPreCheckReport> {
        return {
          model: "preview-model",
          provider: "preview",
          requested: plan.candidates.length,
          outcomes: plan.candidates.map((candidate, index) => ({
            candidateId: candidate.id,
            failureCode: index === 0 ? null : "llm.request_timeout",
            fileCount: 2,
            findingCount: index === 0 ? 0 : 1,
            state: index === 0 ? ("passed" as const) : ("failed" as const),
          })),
        };
      },
    },
    initialSources: [],
    variant: "standard",
  };
}

/**
 * DEV-only preview for the import flow (T4-C): the default scenario keeps the
 * AI pre-check loop used by llm-loops; `?scenario=` selects deterministic
 * layouts (bulk 60+, conflicts, failures, cancel, onboarding variant).
 * Everything runs on the mock facade without native or network calls.
 */
export function ImportWizardPreview() {
  const [scenario] = useState<PreviewScenario>(previewScenario);
  const [setup] = useState<PreviewSetup>(() => createPreviewSetup(scenario));
  return (
    <ImportWizard
      facade={setup.facade}
      initialSources={setup.initialSources}
      variant={setup.variant}
    />
  );
}
