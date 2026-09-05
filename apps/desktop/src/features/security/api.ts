export type SecurityCheckKind = "basic" | "llm";
export type SecurityCheckState = "not_checked" | "running" | "passed" | "failed";
export type SecurityCheck = {
  kind: SecurityCheckKind;
  state: SecurityCheckState;
  checkedAt?: string;
  findingCount: number;
  actionableCount: number;
};
export type SecurityFinding = {
  id: string;
  code: string;
  kind: SecurityCheckKind;
  severity: "low" | "medium" | "high" | "critical";
  file?: string;
  line?: number;
  lineEnd?: number;
  highRisk: boolean;
  disposition: "actionable" | "acknowledged" | "dismissed";
  message: string;
};
export type SecurityPreferences = {
  llmProvider: string;
  dataScope: string;
};
export interface SecurityFacade {
  getChecks(skillId: string, versionId: string): Promise<SecurityCheck[]>;
  listFindings(skillId: string, versionId: string): Promise<SecurityFinding[]>;
  setFindingDisposition(
    finding: SecurityFinding,
    disposition: SecurityFinding["disposition"],
    skillId: string,
    versionId: string,
    highRiskConfirmed: boolean,
  ): Promise<void>;
  getPreferences?(): Promise<SecurityPreferences>;
  runLlmCheck?(skillId: string, versionId: string): Promise<void>;
}

const unavailable = (operation: string): Promise<never> =>
  Promise.reject(new Error(`${operation} is unavailable until the native contract is generated.`));

export const unavailableSecurityFacade: SecurityFacade = {
  getChecks: () => unavailable("security_checks"),
  listFindings: () => unavailable("security_findings"),
  setFindingDisposition: () => unavailable("security_finding_disposition"),
};

export function separateCheckFixture(): { checks: SecurityCheck[]; findings: SecurityFinding[] } {
  return {
    checks: [
      { kind: "basic", state: "passed", checkedAt: "2026-08-27T08:00:00Z", findingCount: 1, actionableCount: 1 },
      { kind: "llm", state: "failed", checkedAt: "2026-08-27T08:05:00Z", findingCount: 1, actionableCount: 1 },
    ],
    findings: [
      {
        id: "finding-1",
        code: "secret-like-string",
        kind: "basic",
        severity: "high",
        file: "SKILL.md",
        line: 18,
        highRisk: true,
        disposition: "actionable",
        message: "发现疑似凭据字符串，请先确认来源。",
      },
    ],
  };
}
