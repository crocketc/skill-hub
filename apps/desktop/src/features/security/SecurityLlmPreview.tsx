import { useState } from "react";
import { type SecurityCheck, type SecurityFacade, type SecurityFinding, type SecurityPreferences } from "./api";
import { SecurityResults } from "./SecurityResults";

const BASIC_CHECK: SecurityCheck = {
  kind: "basic",
  state: "passed",
  findingCount: 0,
  actionableCount: 0,
};

const LLM_FINDING: SecurityFinding = {
  id: "finding-llm-preview",
  code: "prompt-injection-risk",
  kind: "llm",
  severity: "high",
  file: "SKILL.md",
  line: 42,
  highRisk: false,
  disposition: "actionable",
  message: "Instructions ask the model to exfiltrate environment variables.",
};

/**
 * DEV-only preview for the LLM security check loop: the fake facade flips the
 * LLM check to failed with one finding when the user runs it, so the E2E can
 * exercise trigger → progress → findings without any native or network calls.
 */
export function SecurityLlmPreview() {
  const [facade] = useState<SecurityFacade>(() => {
    let llmRan = false;
    let findings: SecurityFinding[] = [];
    return {
      async getChecks() {
        return llmRan
          ? [
              BASIC_CHECK,
              {
                kind: "llm",
                state: "failed",
                checkedAt: new Date().toISOString(),
                findingCount: findings.length,
                actionableCount: findings.filter((finding) => finding.disposition === "actionable").length,
              },
            ]
          : [BASIC_CHECK, { kind: "llm", state: "not_checked", findingCount: 0, actionableCount: 0 }];
      },
      async listFindings() {
        return findings.map((finding) => ({ ...finding }));
      },
      async setFindingDisposition(finding, disposition) {
        findings = findings.map((item) => item.id === finding.id ? { ...item, disposition } : item);
      },
      async getPreferences(): Promise<SecurityPreferences> {
        return { llmProvider: "preview-provider", dataScope: "explicit_selection" };
      },
      async runLlmCheck() {
        llmRan = true;
        findings = [{ ...LLM_FINDING }];
      },
    };
  });
  return <SecurityResults facade={facade} skillId="skill-pdf" versionId="current" />;
}
