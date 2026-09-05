import type { AppliedSourceUpdate, UpdateDecision, UpstreamCheckResult } from "../../api/bindings";
import type {
  BatchAction,
  CheckState,
  SkillLibraryQuery,
  SkillLifecycle,
} from "../skills/api";
import { serializeSkillLibrarySearchParams } from "../skills/queryState";

export interface SkillDetailSummary {
  agentDeploymentCount: number;
  aiCheck: CheckState;
  alias?: string;
  basicCheck: CheckState;
  currentVersion: string;
  highRiskCount: number;
  id: string;
  lifecycle: SkillLifecycle;
  name: string;
  pendingCount: number;
  projectDeploymentCount: number;
  purpose: string;
  trialDue?: string;
  upgradeAvailable: boolean;
  upstreamVersion?: string;
}

export interface SkillTranslation {
  locale: string;
  model: string;
  sourceVersion: string;
  stale: boolean;
  text: string;
  translatedAt: string;
  userRevised: boolean;
}

export interface SkillMetadata {
  alias?: string;
  author?: string;
  copyright?: string;
  invocation?: string;
  license?: string;
  note?: string;
  originalDescription?: string;
  ownership?: string;
  purpose: string;
  source?: string;
  tags: string[];
  translation?: SkillTranslation;
}

export interface SkillMetadataPatch {
  alias?: string | null;
  note?: string | null;
  purpose?: string;
  tags?: string[];
  translationText?: string | null;
}

export interface SkillRelation {
  affectedByCurrentVersion: boolean;
  id: string;
  kind: "agent" | "project";
  label: string;
  logicalTarget: string;
  physicalTarget: string;
  pinned: boolean;
  version: string;
}

export interface SkillRequirementFact {
  declaration: string;
  id: string;
  name: string;
  verification: "declared_only" | "unavailable";
}

export interface SkillDetailInsights {
  combinations: string[];
  dependencies: string[];
  deterministicDuplicates: string[];
  externalChanges: string[];
  operationHistory: Array<{ at: string; id: string; label: string }>;
  semanticDuplicates: string[];
  usageEvidence?: { invocationCount: number; lastUsedAt?: string };
}

export interface SkillFinding {
  code: string;
  disposition: "actionable" | "acknowledged" | "dismissed";
  file?: string;
  highRisk: boolean;
  id: string;
  severity: "info" | "warning" | "error" | "critical";
}

export interface SkillVersionEntry {
  basicCheck: CheckState;
  changes: { added: number; changed: number; removed: number };
  createdAt: string;
  id: string;
  label: string;
  origin: "edit" | "import" | "rollback" | "upstream";
}

export interface SkillVersionDiff {
  added: string[];
  changed: string[];
  leftVersionId: string;
  removed: string[];
  rightVersionId: string;
}

export interface RollbackDeploymentImpact {
  affected: boolean;
  id: string;
  label: string;
  pinned: boolean;
  version: string;
}

export interface SkillRollbackImpact {
  deployments: RollbackDeploymentImpact[];
  rerunsBasicCheck: true;
  targetVersionId: string;
}

export interface AdjacentSkillContext {
  next?: { id: string; name: string };
  position: number;
  previous?: { id: string; name: string };
  total: number;
}

export type SkillDetailIntent =
  | { action: BatchAction; skillId: string; type: "batch" }
  | { skillId: string; type: "abandon_trial" }
  | {
      locale: string;
      overwriteUserRevision: boolean;
      skillId: string;
      type: "translate_description";
    };

export interface SkillDetailFacade {
  commitRollback(
    skillId: string,
    versionId: string,
  ): Promise<{ newVersionId: string }>;
  emitIntent(intent: SkillDetailIntent): Promise<void>;
  getAdjacentContext(
    skillId: string,
    query: SkillLibraryQuery,
  ): Promise<AdjacentSkillContext>;
  getInsights(skillId: string): Promise<SkillDetailInsights>;
  getFindings(
    skillId: string,
    versionId: string,
    kind: "basic" | "llm",
  ): Promise<SkillFinding[]>;
  getMetadata(skillId: string): Promise<SkillMetadata>;
  getRelations(skillId: string): Promise<SkillRelation[]>;
  getRequirements(skillId: string): Promise<SkillRequirementFact[]>;
  getRollbackImpact(
    skillId: string,
    versionId: string,
  ): Promise<SkillRollbackImpact>;
  getSummary(skillId: string): Promise<SkillDetailSummary>;
  getVersionDiff(
    skillId: string,
    leftVersionId: string,
    rightVersionId: string,
  ): Promise<SkillVersionDiff>;
  getVersions(skillId: string): Promise<SkillVersionEntry[]>;
  saveMetadata(skillId: string, patch: SkillMetadataPatch): Promise<void>;
  setTrial(skillId: string, due: string | null): Promise<void>;
  checkSourceUpdate(skillId: string): Promise<UpstreamCheckResult>;
  applySourceUpdate(
    skillId: string,
    decision: UpdateDecision,
  ): Promise<AppliedSourceUpdate>;
}

const skillKey = (skillId: string) => ["skill-detail", skillId] as const;

export const skillDetailKeys = {
  root: ["skill-detail"] as const,
  skill: skillKey,
  summary: (skillId: string) => [...skillKey(skillId), "summary"] as const,
  metadata: (skillId: string) => [...skillKey(skillId), "metadata"] as const,
  relations: (skillId: string) => [...skillKey(skillId), "relations"] as const,
  requirements: (skillId: string) =>
    [...skillKey(skillId), "requirements"] as const,
  insights: (skillId: string) => [...skillKey(skillId), "insights"] as const,
  versions: (skillId: string) => [...skillKey(skillId), "versions"] as const,
  versionDiff: (skillId: string, leftVersionId: string, rightVersionId: string) =>
    [...skillKey(skillId), "version-diff", leftVersionId, rightVersionId] as const,
  rollbackImpact: (skillId: string, versionId: string) =>
    [...skillKey(skillId), "rollback-impact", versionId] as const,
  adjacent: (skillId: string, query: SkillLibraryQuery) =>
    [
      ...skillKey(skillId),
      "adjacent",
      serializeSkillLibrarySearchParams(query).toString(),
    ] as const,
};

export class SkillDetailNotFoundError extends Error {
  constructor(skillId: string) {
    super(`Skill not found: ${skillId}`);
    this.name = "SkillDetailNotFoundError";
  }
}

export class SkillDetailUnavailableError extends Error {
  constructor() {
    super("The Skill detail production contract is unavailable.");
    this.name = "SkillDetailUnavailableError";
  }
}

const unavailable = (): Promise<never> =>
  Promise.reject(new SkillDetailUnavailableError());

export const unavailableSkillDetailFacade: SkillDetailFacade = {
  commitRollback: unavailable,
  emitIntent: unavailable,
  getAdjacentContext: unavailable,
  getInsights: unavailable,
  getFindings: unavailable,
  getMetadata: unavailable,
  getRelations: unavailable,
  getRequirements: unavailable,
  getRollbackImpact: unavailable,
  getSummary: unavailable,
  getVersionDiff: unavailable,
  getVersions: unavailable,
  checkSourceUpdate: unavailable,
  applySourceUpdate: unavailable,
  saveMetadata: unavailable,
  setTrial: unavailable,
};
