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
  severity: "low" | "medium" | "high" | "critical";
  file?: string;
  line?: number;
  highRisk: boolean;
  disposition: "actionable" | "acknowledged" | "dismissed";
  message: string;
};
export interface SecurityFacade {
  getChecks(skillId: string, versionId: string): Promise<SecurityCheck[]>;
  listFindings(skillId: string, versionId: string): Promise<SecurityFinding[]>;
  setFindingDisposition(findingId: string, disposition: SecurityFinding["disposition"]): Promise<void>;
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
