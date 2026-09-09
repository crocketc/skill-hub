import { useState } from "react";
import { createMockImportFacade, type ImportAiPreCheckReport, type MockImportFacade } from "./api";
import { ImportWizard } from "./ImportWizard";

/**
 * DEV-only preview for the import AI pre-check loop: the mock facade carries
 * an AI pre-check that reports one passed and one failed object, so the E2E
 * reaches the conflicts phase through the real wizard steps and exercises the
 * optional pre-check without any native or network calls.
 */
export function ImportWizardPreview() {
  const [facade] = useState<MockImportFacade>(() => {
    const mock = createMockImportFacade({ scenario: "safe-local" });
    return {
      ...mock,
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
    };
  });
  return <ImportWizard facade={facade} />;
}
