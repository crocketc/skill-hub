import type {
  AdjacentSkillContext,
  SkillDetailFacade,
  SkillDetailInsights,
  SkillDetailIntent,
  SkillDetailSummary,
  SkillMetadata,
  SkillMetadataPatch,
  SkillRelation,
  SkillRequirementFact,
  SkillRollbackImpact,
  SkillVersionDiff,
  SkillVersionEntry,
} from "./api";
import { SkillDetailNotFoundError } from "./api";

export interface DetailFixtureOptions {
  userRevisedTranslation?: boolean;
}

export interface SkillDetailFixture {
  adjacent: AdjacentSkillContext;
  insights: SkillDetailInsights;
  metadata: SkillMetadata;
  relations: SkillRelation[];
  requirements: SkillRequirementFact[];
  rollbackImpact: SkillRollbackImpact;
  summary: SkillDetailSummary;
  versionDiff: SkillVersionDiff;
  versions: SkillVersionEntry[];
}

export interface MockSkillDetailCalls {
  committedRollbacks: Array<{ skillId: string; versionId: string }>;
  intents: SkillDetailIntent[];
  metadataPatches: Array<{ patch: SkillMetadataPatch; skillId: string }>;
  trials: Array<{ due: string | null; skillId: string }>;
}

export interface MockSkillDetailOptions {
  adjacent?: AdjacentSkillContext | null;
  deferredRollbackImpact?: boolean;
  failMetadataSave?: boolean;
  failRelations?: boolean;
  failRelationsOnce?: boolean;
  failRollbackCommit?: boolean;
  failSummaryOnce?: boolean;
  failTrialSave?: boolean;
  missingSkill?: boolean;
  sharedPhysicalTarget?: boolean;
  summary?: Partial<SkillDetailSummary>;
  usageEvidence?: SkillDetailInsights["usageEvidence"] | null;
}

export interface MockSkillDetailFacade extends SkillDetailFacade {
  calls: MockSkillDetailCalls;
}

const previewSkillOrder = ["skill-doc", "skill-pdf", "skill-sheet"] as const;
const previewSkillTotal = 80;

const previewSkillSummaries: Record<string, Partial<SkillDetailSummary>> = {
  "skill-doc": {
    alias: "DOCX 文档写作",
    name: "DOCX Writer",
    purpose: "Create Word documents",
  },
  "skill-sheet": {
    alias: "表格数据读取",
    name: "Spreadsheet Reader",
    purpose: "Read spreadsheet data",
  },
};

const previewSkillMetadata: Record<string, Partial<SkillMetadata>> = {
  "skill-doc": {
    invocation: "docx-writer <file>",
    originalDescription: "Create and update Word documents.",
    source: "github:example/docx-writer",
    tags: ["documents", "word"],
  },
  "skill-sheet": {
    invocation: "spreadsheet-reader <file>",
    originalDescription: "Read spreadsheet data safely.",
    source: "github:example/spreadsheet-reader",
    tags: ["documents", "spreadsheet"],
  },
};

export function detailFixture(
  options: DetailFixtureOptions = {},
): SkillDetailFixture {
  return {
    adjacent: {
      next: { id: "skill-sheet", name: "Spreadsheet Reader" },
      position: 2,
      previous: { id: "skill-doc", name: "Document Reader" },
      total: 80,
    },
    insights: {
      combinations: ["Document toolkit"],
      dependencies: ["table-normalizer"],
      deterministicDuplicates: [],
      externalChanges: ["SKILL.md changed outside SkillHub"],
      operationHistory: [
        { at: "2026-08-25T10:24:00Z", id: "operation-import", label: "Imported" },
      ],
      semanticDuplicates: ["pdf-extractor"],
      usageEvidence: {
        invocationCount: 12,
        lastUsedAt: "2026-08-25T09:30:00Z",
      },
    },
    metadata: {
      alias: "PDF 表格读取器",
      author: "Example Author",
      copyright: "Copyright 2026 Example Author",
      invocation: "pdf-reader <file>",
      license: "MIT",
      note: "用于 PDF 表格提取",
      originalDescription: "Original description",
      ownership: "managed",
      purpose: "用于 PDF 表格提取",
      source: "github:example/pdf-reader",
      tags: ["documents", "pdf"],
      translation: {
        locale: "zh-CN",
        model: "local-fixture",
        sourceVersion: "v2.4.1",
        stale: false,
        text: "模型译文",
        translatedAt: "2026-08-25T09:00:00Z",
        userRevised: options.userRevisedTranslation ?? false,
      },
    },
    relations: [
      {
        affectedByCurrentVersion: true,
        id: "relation-codex",
        kind: "agent",
        label: "Codex CLI",
        logicalTarget: "openai.codex-cli",
        physicalTarget: "C:/Users/demo/.agents/skills/pdf-reader",
        pinned: false,
        version: "v2.4.1",
      },
      {
        affectedByCurrentVersion: false,
        id: "relation-project",
        kind: "project",
        label: "Demo Project",
        logicalTarget: "project-demo",
        physicalTarget: "C:/Projects/demo/.agents/skills/pdf-reader",
        pinned: true,
        version: "v2.4.0",
      },
    ],
    requirements: [
      {
        declaration: "Executable used for PDF rendering",
        id: "requirement-poppler",
        name: "Poppler",
        verification: "declared_only",
      },
    ],
    rollbackImpact: {
      deployments: [
        {
          affected: true,
          id: "deployment-codex",
          label: "Codex CLI",
          pinned: false,
          version: "v2.4.1",
        },
        {
          affected: false,
          id: "deployment-project",
          label: "Demo Project",
          pinned: true,
          version: "v2.4.0",
        },
      ],
      rerunsBasicCheck: true,
      targetVersionId: "version-240",
    },
    summary: {
      agentDeploymentCount: 1,
      aiCheck: "not_run",
      alias: "PDF 表格读取器",
      basicCheck: "passed",
      currentVersion: "v2.4.1",
      highRiskCount: 0,
      id: "skill-pdf",
      lifecycle: "active",
      name: "PDF Reader",
      pendingCount: 0,
      projectDeploymentCount: 1,
      purpose: "用于 PDF 表格提取",
      upgradeAvailable: false,
    },
    versionDiff: {
      added: ["references/new-format.md"],
      changed: ["SKILL.md", "references/tables.md"],
      leftVersionId: "version-240",
      removed: [],
      rightVersionId: "version-241",
    },
    versions: [
      {
        basicCheck: "passed",
        changes: { added: 1, changed: 2, removed: 0 },
        createdAt: "2026-08-25T10:24:00Z",
        id: "version-241",
        label: "v2.4.1",
        origin: "upstream",
      },
      {
        basicCheck: "passed",
        changes: { added: 0, changed: 1, removed: 0 },
        createdAt: "2026-08-18T08:00:00Z",
        id: "version-240",
        label: "v2.4.0",
        origin: "edit",
      },
      {
        basicCheck: "passed",
        changes: { added: 8, changed: 0, removed: 0 },
        createdAt: "2026-08-10T08:00:00Z",
        id: "version-232",
        label: "v2.3.2",
        origin: "import",
      },
    ],
  };
}

export function trialDetailFixture(): SkillDetailFixture {
  const fixture = detailFixture();
  return {
    ...fixture,
    summary: {
      ...fixture.summary,
      lifecycle: "trial",
      trialDue: "2026-09-01",
    },
  };
}

export function rollbackFixture(): SkillDetailFixture {
  return detailFixture();
}

export function createMockSkillDetailFacade(
  options: MockSkillDetailOptions = {},
): MockSkillDetailFacade {
  const fixture = detailFixture();
  const calls: MockSkillDetailCalls = {
    committedRollbacks: [],
    intents: [],
    metadataPatches: [],
    trials: [],
  };
  let metadata = fixture.metadata;
  let summary = fixture.summary;
  let summaryFailures = options.failSummaryOnce ? 1 : 0;
  let relationFailures = options.failRelationsOnce ? 1 : 0;

  const relations = options.sharedPhysicalTarget
    ? fixture.relations.map((relation) => ({
        ...relation,
        physicalTarget: "C:/Shared/skills/pdf-reader",
      }))
    : fixture.relations;
  const insights = {
    ...fixture.insights,
    usageEvidence:
      "usageEvidence" in options
        ? options.usageEvidence ?? undefined
        : fixture.insights.usageEvidence,
  };

  return {
    calls,
    async commitRollback(skillId, versionId) {
      calls.committedRollbacks.push({ skillId, versionId });
      if (options.failRollbackCommit) throw new Error("rollback failed");
      return { newVersionId: "version-rollback" };
    },
    async emitIntent(intent) {
      calls.intents.push(intent);
    },
    async getAdjacentContext(skillId) {
      if ("adjacent" in options) {
        return options.adjacent ?? { position: 1, total: 1 };
      }
      const position = Math.max(0, previewSkillOrder.indexOf(skillId as (typeof previewSkillOrder)[number]));
      const previousId = previewSkillOrder[position - 1];
      const nextId = previewSkillOrder[position + 1];
      return {
        next: nextId
          ? { id: nextId, name: previewSkillSummaries[nextId]?.name ?? nextId }
          : undefined,
        position: position + 1,
        previous: previousId
          ? { id: previousId, name: previewSkillSummaries[previousId]?.name ?? previousId }
          : undefined,
        total: previewSkillTotal,
      };
    },
    async getInsights() {
      return insights;
    },
    async getFindings(_skillId, _versionId, kind) {
      return kind === "basic"
        ? [{
            id: "finding-basic",
            code: "fixture_rule",
            disposition: "actionable" as const,
            file: "SKILL.md",
            highRisk: false,
            severity: "warning" as const,
          }]
        : [];
    },
    async getMetadata(skillId) {
      return {
        ...metadata,
        ...previewSkillSummaries[skillId],
        ...previewSkillMetadata[skillId],
      };
    },
    async getRelations(skillId) {
      if (options.failRelations || relationFailures > 0) {
        relationFailures = Math.max(0, relationFailures - 1);
        throw new Error("relations failed");
      }
      if (skillId === "skill-pdf") return relations;
      return relations.map((relation) => ({
        ...relation,
        physicalTarget: relation.physicalTarget.replace("pdf-reader", skillId),
      }));
    },
    async getRequirements() {
      return fixture.requirements;
    },
    async getRollbackImpact() {
      if (options.deferredRollbackImpact) {
        return new Promise<never>(() => undefined);
      }
      return fixture.rollbackImpact;
    },
    async getSummary(skillId) {
      if (options.missingSkill) throw new SkillDetailNotFoundError(skillId);
      if (summaryFailures > 0) {
        summaryFailures -= 1;
        throw new Error("summary failed");
      }
      return {
        ...summary,
        ...options.summary,
        ...previewSkillSummaries[skillId],
        id: skillId,
      };
    },
    async getVersionDiff() {
      return fixture.versionDiff;
    },
    async getVersions() {
      return fixture.versions;
    },
    async saveMetadata(skillId, patch) {
      calls.metadataPatches.push({ patch, skillId });
      if (options.failMetadataSave) throw new Error("metadata save failed");
      metadata = {
        ...metadata,
        alias: patch.alias === null ? undefined : patch.alias ?? metadata.alias,
        note: patch.note === null ? undefined : patch.note ?? metadata.note,
        purpose: patch.purpose ?? metadata.purpose,
        tags: patch.tags ?? metadata.tags,
        translation:
          patch.translationText === undefined
            ? metadata.translation
            : patch.translationText === null
              ? undefined
              : metadata.translation
                ? { ...metadata.translation, text: patch.translationText, userRevised: true }
                : undefined,
      };
    },
    async setTrial(skillId, due) {
      calls.trials.push({ due, skillId });
      if (options.failTrialSave) throw new Error("trial save failed");
      summary = { ...summary, trialDue: due ?? undefined };
    },
  };
}
