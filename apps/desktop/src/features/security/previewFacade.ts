import { separateCheckFixture, type SecurityCheckKind, type SecurityFacade } from "./api";

type PreviewSnapshot = ReturnType<typeof separateCheckFixture>;

/** Stateful, in-memory security data for the interactive development previews. */
export function createPreviewSecurityFacade(now: () => Date = () => new Date()): SecurityFacade {
  const snapshots = new Map<string, PreviewSnapshot>();
  const snapshotFor = (skillId: string, versionId: string) => {
    const key = `${skillId}\u0000${versionId}`;
    let snapshot = snapshots.get(key);
    if (!snapshot) {
      const fixture = separateCheckFixture();
      snapshot = {
        checks: fixture.checks.map((check) => ({ ...check })),
        findings: fixture.findings.map((finding) => ({ ...finding })),
      };
      snapshots.set(key, snapshot);
    }
    return snapshot;
  };
  const runCheck = async (skillId: string, versionId: string, kind: SecurityCheckKind) => {
    const snapshot = snapshotFor(skillId, versionId);
    const findings = snapshot.findings.filter((finding) => finding.kind === kind);
    const current = snapshot.checks.find((check) => check.kind === kind);
    const updated = {
      kind,
      state: "passed" as const,
      checkedAt: now().toISOString(),
      findingCount: findings.length,
      actionableCount: findings.filter((finding) => finding.disposition === "actionable").length,
    };
    snapshot.checks = current
      ? snapshot.checks.map((check) => check.kind === kind ? updated : check)
      : [...snapshot.checks, updated];
  };

  return {
    async getChecks(skillId, versionId) {
      return snapshotFor(skillId, versionId).checks.map((check) => ({ ...check }));
    },
    async listFindings(skillId, versionId) {
      return snapshotFor(skillId, versionId).findings.map((finding) => ({ ...finding }));
    },
    async setFindingDisposition(finding, disposition, skillId, versionId) {
      const snapshot = snapshotFor(skillId, versionId);
      snapshot.findings = snapshot.findings.map((item) => item.id === finding.id ? { ...item, disposition } : item);
      snapshot.checks = snapshot.checks.map((check) => {
        if (check.kind !== finding.kind) return check;
        return {
          ...check,
          actionableCount: snapshot.findings.filter((item) => item.kind === finding.kind && item.disposition === "actionable").length,
        };
      });
    },
    async getPreferences() {
      return { llmProvider: "preview-provider", dataScope: "explicit_selection" };
    },
    runBasicCheck: (skillId, versionId) => runCheck(skillId, versionId, "basic"),
    runLlmCheck: (skillId, versionId) => runCheck(skillId, versionId, "llm"),
  };
}
