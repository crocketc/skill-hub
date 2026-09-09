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
  const [llmRan, setLlmRan] = useState(false);
  const facade: SecurityFacade = {
    async getChecks() {
      return llmRan
        ? [
            BASIC_CHECK,
            {
              kind: "llm",
              state: "failed",
              checkedAt: "2026-09-10T08:00:00Z",
              findingCount: 1,
              actionableCount: 1,
            },
          ]
        : [BASIC_CHECK, { kind: "llm", state: "not_checked", findingCount: 0, actionableCount: 0 }];
    },
    async listFindings() {
      return llmRan ? [LLM_FINDING] : [];
    },
    async setFindingDisposition() {
      // 预览不需要持久化处置；SecurityResults 自己更新列表状态。
    },
    async getPreferences(): Promise<SecurityPreferences> {
      return { llmProvider: "preview-provider", dataScope: "explicit_selection" };
    },
    async runLlmCheck() {
      setLlmRan(true);
    },
    async cancelLlmCheck() {},
    async listRunningLlmChecks() {
      return [];
    },
  };
  return <SecurityResults facade={facade} skillId="skill-pdf" versionId="current" />;
}
