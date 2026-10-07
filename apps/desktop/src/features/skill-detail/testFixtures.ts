import type {
  AnalyzeConflictScope,
  ConflictAnalysis,
  RelationshipOverview,
  RemovalImpactFact,
  SourceUpdatePreview,
  SourceUpdateStatus,
  UpdateDecision,
  UpstreamCheckResult,
} from "../../api/bindings";
import type {
  SkillProvenance,
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
  SourceRelinkInput,
} from "./api";
import { SkillDetailNotFoundError } from "./api";

export interface DetailFixtureOptions {
  userRevisedTranslation?: boolean;
}

export interface SkillDetailFixture {
  insights: SkillDetailInsights;
  metadata: SkillMetadata;
  provenance: SkillProvenance;
  relations: SkillRelation[];
  requirements: SkillRequirementFact[];
  rollbackImpact: SkillRollbackImpact;
  summary: SkillDetailSummary;
  versionDiff: SkillVersionDiff;
  versions: SkillVersionEntry[];
}

export interface MockSkillDetailCalls {
  /** K6：采纳入口先取得预览；记录 prepare 调用。 */
  preparedSourceUpdates: Array<{ skillId: string }>;
  /** K6：确认后按 preview_id 提交决定。 */
  committedSourceUpdates: Array<{ decision: UpdateDecision; previewId: string }>;
  /** K6/D3：按候选身份忽略。 */
  ignoredSourceUpdates: Array<{ candidateIdentity: string; skillId: string }>;
  relinkSourceInputs: Array<{ skillId: string; source: SourceRelinkInput }>;
  checkedSourceUpdates: Array<{ skillId: string }>;
  committedRollbacks: Array<{ skillId: string; versionId: string }>;
  intents: SkillDetailIntent[];
  versionLabels: Array<{ skillId: string; versionId: string; label: string }>;
  metadataPatches: Array<{ patch: SkillMetadataPatch; skillId: string }>;
  trials: Array<{ due: string | null; skillId: string }>;
  analyzedDuplicateSkills: string[];
  /** Task 8：Skill 维度冲突分析调用记录（含 scope）。 */
  analyzedConflictScopes: AnalyzeConflictScope[];
}

export interface MockSkillDetailOptions {
  /** Task 8：AI 可用性（缺省 true，与导入向导 mock 行为一致）。 */
  aiAvailable?: boolean;
  sourceUpdateResult?: UpstreamCheckResult;
  /** W3-4：getSourceUpdateStatus 的持久化状态投影（缺省为从未检查）。 */
  sourceUpdateStatus?: SourceUpdateStatus;
  /** W3-4：relinkSource 抛错路径。 */
  failRelinkSource?: boolean;
  deferredRollbackImpact?: boolean;
  failMetadataSave?: boolean;
  failRelations?: boolean;
  failRelationsOnce?: boolean;
  failRollbackCommit?: boolean;
  failSummaryOnce?: boolean;
  failTrialSave?: boolean;
  missingSkill?: boolean;
  operationHistoryLimitation?: string;
  /** Task 7：注入 Skill 维度关系概览；缺省为空概览（诚实空态）。 */
  relationshipOverview?: RelationshipOverview;
  removalImpactFact?: RemovalImpactFact;
  sharedPhysicalTarget?: boolean;
  summary?: Partial<SkillDetailSummary>;
  usageEvidence?: SkillDetailInsights["usageEvidence"] | null;
}

export interface MockSkillDetailFacade extends SkillDetailFacade {
  calls: MockSkillDetailCalls;
}

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
  // T3-C：确定性长文本夹具——120+ 字符名称与长路径的布局回归入口。
  "skill-long": {
    alias:
      "超长别名的布局回归夹具，用于验证中文别名、英文别名与很长的附加说明文字在详情身份区不会溢出或被裁切",
    name:
      "Long Named Skill For Layout Regression Coverage With Unusual Multi Segment Title Text And Extended Verification Suffix Words",
    purpose:
      "Cover long alias, long name and long source path rendering in the detail identity zone without overflow or clipping.",
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
  "skill-long": {
    invocation: "long-named-skill --input ./very/deeply/nested/directory/structure/with/long/segment-names/input.pdf",
    originalDescription:
      "Long fixture description used to verify wrapping behaviour for user-provided metadata in narrow columns.",
    source: "file:///D:/Very/Long/Library/Roots/example-user/central-skills/long-named-skill",
    tags: ["layout-regression", "long-text", "identity"],
  },
};

export function detailFixture(
  options: DetailFixtureOptions = {},
): SkillDetailFixture {
  return {
    insights: {
      // G-18：组合/依赖/外部变化都是结构化事实（成员标签、形态、状态、路径）。
      combinations: [
        { name: "Document toolkit", otherMemberLabels: ["Spreadsheet Reader"] },
      ],
      dependencies: [
        {
          agentClientId: "openai.codex-cli",
          id: "relation-codex",
          path: "C:/Users/demo/.agents/skills/pdf-reader",
          shapeLabel: "Managed link",
        },
      ],
      // P1-12：确定性候选常显——夹具给出一条，验证独立小节不混入合并列表。
      deterministicDuplicates: ["PDF Reader（副本）"],
      externalChanges: [
        {
          id: "relation-project",
          path: "SKILL.md",
          stateLabel: "Content diverged from the central library",
        },
      ],
      operationHistory: [
        { at: "2026-08-25T10:24:00Z", id: "operation-import", label: "Imported" },
      ],
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
      // P1-12：备注与用途取不同文案，避免页面级"只出现一次"断言被夹具巧合破坏。
      note: "备注：部署前先人工复核一次",
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
    provenance: {
      provenance: {
        agentClientId: "openai.codex-cli",
        contentFingerprint: "sha256:fixture-fingerprint",
        importedAt: "1757808000",
        originalPath: "C:/Users/demo/.agents/skills/pdf-reader",
        ownership: "known_agent_target",
        sourceKind: "local",
        sourceLocator: "C:/Users/demo/.agents/skills/pdf-reader",
      },
      observedDeployments: [
        {
          clientId: "openai.codex-cli",
          contentFingerprint: "sha256:fixture-fingerprint",
          id: "observed-codex",
          matchState: "content_verified",
          observedAt: "1757808100",
          originalPath: "C:/Users/demo/.agents/skills/pdf-reader",
          origin: "import",
          releasedAt: null,
          status: "active",
        },
      ],
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
      currentVersionId: "version-241",
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
        current: true,
      },
      {
        basicCheck: "passed",
        changes: { added: 0, changed: 1, removed: 0 },
        createdAt: "2026-08-18T08:00:00Z",
        id: "version-240",
        label: "v2.4.0",
        origin: "edit",
        current: false,
      },
      {
        basicCheck: "passed",
        changes: { added: 8, changed: 0, removed: 0 },
        createdAt: "2026-08-10T08:00:00Z",
        id: "version-232",
        label: "v2.3.2",
        origin: "import",
        current: false,
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
    preparedSourceUpdates: [],
    committedSourceUpdates: [],
    ignoredSourceUpdates: [],
    checkedSourceUpdates: [],
    relinkSourceInputs: [],
    committedRollbacks: [],
    intents: [],
    versionLabels: [],
    metadataPatches: [],
    trials: [],
    analyzedDuplicateSkills: [],
    analyzedConflictScopes: [],
  };
  let metadata = fixture.metadata;
  // W3-7：options.summary 只作为初始读数合并一次；setTrial 等写入改可变
  // summary 后，后续 getSummary 必须能看到生效结果（与真实目录一致）。
  let summary = { ...fixture.summary, ...options.summary };
  let summaryFailures = options.failSummaryOnce ? 1 : 0;
  let relationFailures = options.failRelationsOnce ? 1 : 0;
  // K6：忽略决定按候选身份持久投影——与真实后端一致，忽略后重新拉取
  // 状态仍能看到 candidate_ignored，入口随之隐藏。
  const ignoredCandidates = new Set<string>();

  const relations = options.sharedPhysicalTarget
    ? fixture.relations.map((relation) => ({
        ...relation,
        physicalTarget: "C:/Shared/skills/pdf-reader",
      }))
    : fixture.relations;
  const insights = {
    ...fixture.insights,
    operationHistoryLimitation: options.operationHistoryLimitation,
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
    async setVersionLabel(skillId, versionId, label) {
      calls.versionLabels.push({ skillId, versionId, label });
    },
    async emitIntent(intent) {
      calls.intents.push(intent);
      if (intent.type === "translate_description") {
        // 预览闭环：模拟后端重新翻译成功，元数据中的译文随之刷新。
        metadata = {
          ...metadata,
          translation: {
            locale: intent.locale,
            model: "preview-model",
            sourceVersion: "current",
            stale: false,
            text: `Retranslated description (${intent.locale})`,
            translatedAt: "2026-09-10T08:00:00Z",
            userRevised: false,
          },
        };
      }
    },
    async getInsights() {
      return insights;
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
    async getProvenance() {
      return fixture.provenance;
    },
    async getRelationshipOverview(skillId) {
      // Task 7：页面级测试可用 options.relationshipOverview 注入关系事实；
      // 缺省给出空概览（诚实空态），绝不错标为"已确认"。
      return options.relationshipOverview ?? {
        scope: { type: "skill" as const, value: { skill_id: skillId } },
        directory_nodes: [],
        agent_directory_capabilities: [],
        source_relations: [],
        deployment_relations: [],
        conflict_cases: [],
        pending_governance_tasks: [],
        agent_execution_confirmed: false as const,
      };
    },
    async getRelationshipRemovalImpact(relationId) {
      if (options.removalImpactFact) return options.removalImpactFact;
      throw new Error(`removal impact ${relationId} is not part of this fixture`);
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
    async checkSourceUpdate(skillId) {
      calls.checkedSourceUpdates.push({ skillId });
      if (options.sourceUpdateResult) return options.sourceUpdateResult;
      return { skill_id: skillId, state: "up_to_date", local_version: null, upstream_version: null };
    },
    async prepareSourceUpdate(skillId) {
      calls.preparedSourceUpdates.push({ skillId });
      const preview: SourceUpdatePreview = {
        skill_id: skillId,
        preview_id: "preview-1",
        expires_at: "2026-12-31T00:00:00Z",
        confirmation_fingerprint: "fp-mock",
        current_version_id: null,
        candidate_identity: "sha256:mockcandidate",
        upstream_label: null,
        files: [
          { path: "SKILL.md", change: "modified" },
          { path: "scripts/run.py", change: "added" },
        ],
      };
      return preview;
    },
    async commitSourceUpdate(previewId, decision) {
      calls.committedSourceUpdates.push({ decision, previewId });
      return {
        skill_id: "skill-doc",
        decision,
        new_version: decision === "take_upstream" ? "sha256:newversion" : null,
        deployments_need_reconciliation: false,
      };
    },
    async ignoreSourceUpdate(skillId, candidateIdentity) {
      calls.ignoredSourceUpdates.push({ candidateIdentity, skillId });
      ignoredCandidates.add(candidateIdentity);
    },
    async getSourceUpdateStatus(skillId): Promise<SourceUpdateStatus> {
      const status = options.sourceUpdateStatus ?? {
        skill_id: skillId,
        state: null,
        checked_at: null,
        upstream_label: null,
        candidate_identity: null,
        ignored_candidates: [],
        candidate_ignored: false,
      };
      if (status.candidate_identity && ignoredCandidates.has(status.candidate_identity)) {
        return { ...status, candidate_ignored: true, ignored_candidates: [status.candidate_identity] };
      }
      return status;
    },
    async relinkSource(skillId, source) {
      if (options.failRelinkSource) throw new Error("relink failed");
      calls.relinkSourceInputs.push({ skillId, source });
      return { messageCode: "source.relinked" };
    },
        async setTrial(skillId, due) {
      calls.trials.push({ due, skillId });
      if (options.failTrialSave) throw new Error("trial save failed");
      // W3-7：与原生 set_trial 派生规则一致——试用是 trial_due 的派生态。
      summary = { ...summary, lifecycle: due ? "trial" : "active", trialDue: due ?? undefined };
    },
    async analyzeSemanticDuplicates(skillId) {
      calls.analyzedDuplicateSkills.push(skillId);
      return {
        candidates: [
          {
            basicCheckState: "passed",
            description: "Reads text out of PDF files",
            id: "skill-pdf-alt",
            locallyModified: false,
            name: "PDF Text Extractor",
            permissions: ["fs.read"],
            source: "github.com/example/pdf-extractor",
            trigger: "pdf text",
          },
        ],
        failureCode: null,
        source: "llm",
      };
    },
    // Task 8：默认 mock 供应商已配置（与导入向导 mock 的历史行为一致）。
    async isAiAvailable() {
      return options.aiAvailable ?? true;
    },
    async analyzeConflicts(scope): Promise<ConflictAnalysis> {
      calls.analyzedConflictScopes.push(scope);
      return {
        scope,
        input_fingerprint: "sha256:mock",
        skipped_decided_cases: 0,
        total_case_count: 0,
        source: "llm",
        failure_code: null,
        cases: [],
      };
    },
  };
}
