import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type ImportAnalysis,
  type ImportBatchConflictAnalysis,
  type ImportCandidate as NativeImportCandidate,
  type ImportDecision,
  type ImportGovernanceDecision,
  type ImportGovernanceGroup,
  type PreparedImport,
} from "../../api/bindings";
import { keyedMessage, nativeErrorCode, nativeErrorParams } from "../../api/nativeErrors";
import {
  ImportCancelledError,
  parseSourceInput,
  type ImportAction,
  type ImportBatchAnalysis,
  type ImportCandidate,
  type ImportConflict,
  type ImportFacade,
  type ImportMatchedSkill,
  type ImportResult,
  type ImportSecurityFindingView,
  type ImportSecurityPlan,
  type ImportSecuritySummaryView,
  type SourceDescriptor,
} from "./api";
import { normalizeWindowsPath } from "../../platform/directoryPicker";

function nativeSource(source: SourceDescriptor) {
  if (source.kind === "local_path") {
    return { kind: "local" as const, locator: { local_path: normalizeWindowsPath(source.displayTarget) } };
  }
  if (source.kind === "url") {
    return { kind: "https" as const, locator: { https_url: source.displayTarget } };
  }
  if (source.kind === "git") {
    return { kind: "git" as const, locator: { git_url: canonicalGitSource(source.displayTarget) } };
  }
  if (source.kind === "npx_reference") {
    const target = source.displayTarget.trim().split(/\s+/)[0] ?? "";
    if (/^(?:github|gitlab):/i.test(target)) {
      return nativeSource({ ...source, kind: "git", displayTarget: target });
    }
    if (/^[^/\s]+\/[^/\s]+$/.test(target)) {
      return nativeSource({ ...source, kind: "git", displayTarget: `github:${target}` });
    }
    if (/^https:\/\//i.test(target)) {
      return nativeSource({ ...source, kind: "url", displayTarget: target });
    }
    throw new Error("import.source_not_supported");
  }
  throw new Error("import.source_not_supported");
}

function canonicalGitSource(value: string): string {
  if (/^github:/i.test(value)) return `https://github.com/${value.slice("github:".length).replace(/\/$/, "")}`;
  if (/^gitlab:/i.test(value)) return `https://gitlab.com/${value.slice("gitlab:".length).replace(/\/$/, "")}`;
  if (/^git\+https:\/\//i.test(value)) return value.replace(/^git\+/, "");
  return value;
}

function candidateSource(source: NativeImportCandidate["source"]): SourceDescriptor {
  if (source.locator.local_path) {
    return {
      displayTarget: normalizeWindowsPath(source.locator.local_path),
      executesCommand: false,
      input: normalizeWindowsPath(source.locator.local_path),
      kind: "local_path",
    };
  }
  if (source.locator.https_url) {
    return {
      displayTarget: source.locator.https_url,
      executesCommand: false,
      input: source.locator.https_url,
      kind: "url",
    };
  }
  if (source.locator.git_url) {
    return {
      displayTarget: source.locator.git_url,
      executesCommand: false,
      input: source.locator.git_url,
      kind: "git",
    };
  }
  throw new Error("import.source_not_supported");
}

function candidateId(candidate: NativeImportCandidate): string {
  return `${normalizeWindowsPath(candidate.absolute_root)}#${candidate.relative_root}`;
}

function ownership(ownership: NativeImportCandidate["ownership"]): ImportCandidate["ownership"] {
  switch (ownership) {
    case "central_library":
      return "managed";
    case "known_agent_target":
      return "agent_builtin";
    case "read_only_builtin_or_plugin":
      return "plugin";
    case "downloaded_source":
      return "other_tool";
    case "unclassified":
    case "registered_project":
    case "arbitrary_local_directory":
      return "unknown";
  }
}

function toCandidate(candidate: NativeImportCandidate): ImportCandidate {
  return {
    basicCheck: "not_checked",
    id: candidateId(candidate),
    name: candidate.runtime_name,
    frontmatterName: candidate.frontmatter_name ?? null,
    ownership: ownership(candidate.ownership),
    path: normalizeWindowsPath(candidate.absolute_root),
    // W2-2：相对根是批内候选键的稳定后缀，用于组键 → 前端候选的映射。
    relativeRoot: candidate.relative_root,
    source: candidateSource(candidate.source),
  };
}

function conflictKind(kind: ImportAnalysis["conflicts"][number]["kind"]): ImportConflict["kind"] {
  switch (kind) {
    case "exact_content":
    case "same_source":
      return "exact_duplicate";
    case "same_runtime_name_different_content":
      return "same_name";
    case "search_candidate":
      return "semantic_match";
  }
}

function actionForDecision(decision: ImportDecision): ImportAction | undefined {
  switch (decision) {
    case "reuse_existing":
      return "reuse";
    case "copy_into_library":
      return "copy";
    case "take_over_after_verify":
      return "takeover";
    case "keep_independent":
    case "copy_as_independent_managed_skill":
      return "independent";
    case "skip":
      return "skip";
    case "establish_managed_relation":
      return undefined;
  }
}

function decisionForAction(action: ImportAction, allowed?: ImportDecision[]): ImportDecision {
  switch (action) {
    case "reuse":
      return "reuse_existing";
    case "copy":
      return "copy_into_library";
    case "takeover":
      return "take_over_after_verify";
    case "independent":
      return allowed?.includes("copy_as_independent_managed_skill")
        ? "copy_as_independent_managed_skill"
        : "keep_independent";
    case "skip":
      return "skip";
  }
}

function defaultDecision(allowed: ImportDecision[]): ImportDecision {
  const supportedDefaults: ImportDecision[] = [
    "copy_into_library",
    "copy_as_independent_managed_skill",
    "keep_independent",
    "reuse_existing",
    "take_over_after_verify",
    "skip",
  ];
  const decision = supportedDefaults.find((candidate) => allowed.includes(candidate));
  if (!decision) {
    throw new Error("import.no_default_action");
  }
  return decision;
}

function resultForSummary(
  candidate: ImportCandidate,
  action: ImportAction,
  result: Extract<AppCommandResult, { type: "import_summary" }>["payload"],
): ImportResult {
  const item = result.items[0];
  const reasonCode = item?.reason_code ?? undefined;
  return {
    action,
    candidateId: candidate.id,
    message: keyedMessage(reasonCode ?? null, undefined)
      ?? (item?.skill_id
        ? "importWorkflow.commitMessages.imported"
        : "importWorkflow.commitMessages.noDetail"),
    status: item?.status ?? (result.committed ? "succeeded" : "failed"),
    reasonCode,
    originalPreserved: item?.original_preserved ?? true,
    governanceTasks: item?.governance_tasks,
    provenance: item?.provenance
      ? {
          agentClientId: item.provenance.agent_client_id,
          originalPath: item.provenance.original_path,
          importedAt: item.provenance.imported_at,
          // 任务 10：在线来源展示服务/仓库地址；本地缓存路径不进界面。
          sourceKind: item.provenance.source.kind,
          sourceLocator:
            item.provenance.source.locator.https_url
            ?? item.provenance.source.locator.git_url,
        }
      : undefined,
    // 计划 9.7：逐项稳定身份来自生成 DTO，绝不从结果数组下标或缓存路径推断。
    skillId: item?.skill_id ?? undefined,
    sourceRelationId: item?.source_relation_id ?? undefined,
  };
}

function mergeGovernanceGroups(groups: ImportGovernanceGroup[]): ImportGovernanceGroup[] {
  const merged = new Map<string, ImportGovernanceGroup>();
  for (const group of groups) {
    const current = merged.get(group.group_id);
    if (current) {
      current.members.push(...group.members);
    } else {
      merged.set(group.group_id, { ...group, members: [...group.members] });
    }
  }
  return [...merged.values()];
}

function decisionForPrepared(
  decision: ImportGovernanceDecision,
  groups: ImportGovernanceGroup[],
): ImportGovernanceDecision {
  const memberIds = new Set(groups.flatMap((group) => group.members.map((member) => member.member_id)));
  return {
    group_actions: Object.fromEntries(groups.flatMap((group) => {
      const action = decision.group_actions[group.group_id];
      return action ? [[group.group_id, action]] : [];
    })),
    item_overrides: Object.fromEntries(Object.entries(decision.item_overrides)
      .filter(([memberId]) => memberIds.has(memberId))),
  };
}

function importErrorMessage(error: unknown): string {
  const code = nativeErrorCode(error);
  const params = nativeErrorParams(error);
  const reason = typeof params.reason === "string" ? params.reason : undefined;
  const keyed = keyedMessage(code, reason);
  if (keyed) return keyed;
  if (code) return "importWorkflow.errors.unknown";
  if (error instanceof Error) return error.message || "importWorkflow.errors.unknown";
  if (typeof error === "string") {
    try {
      return importErrorMessage(JSON.parse(error) as unknown);
    } catch {
      return error;
    }
  }
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown; params?: unknown };
    const message = typeof record.message === "string" ? record.message : null;
    if (message) return message;
  }
  return "importWorkflow.errors.unknown";
}

function queryImportCandidates(result: AppQueryResult): NativeImportCandidate[] {
  if (result.type !== "import_candidates") {
    throw new Error("native import candidate query returned an unexpected result");
  }
  return result.payload;
}

function queryImportAnalysis(result: AppQueryResult): ImportAnalysis {
  if (result.type !== "import_analysis") {
    throw new Error("native import analysis query returned an unexpected result");
  }
  return result.payload;
}

function queryImportBatchAnalysis(result: AppQueryResult): ImportBatchConflictAnalysis {
  if (result.type !== "import_batch_analysis") {
    throw new Error("native import batch analysis query returned an unexpected result");
  }
  return result.payload;
}

const IS_WINDOWS =
  typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);

/** 镜像后端 observed_path_key：统一分隔符；Windows 上小写（路径大小写不敏感）。 */
function observedPathKey(relativeRoot: string | null | undefined): string {
  const value = (relativeRoot ?? "").replace(/\\/g, "/");
  return IS_WINDOWS ? value.toLowerCase() : value;
}

/**
 * 把批内分组的后端稳定候选键映射回前端候选 id：键前缀是来源身份的 SipHash
 * （TS 无法复现），后缀是 observed path key。按「后缀 + 组归一化名」匹配，
 * 同键多个候选按 id 排序、未占用者优先，保证确定性；无法诚实映射的键
 * 直接丢弃，绝不伪造成员。边界：同名且同相对路径但来源不同的极端批会
 * 出现键歧义——处置挂在解析顺序候选上仍可有效提交，最终裁决由后端按
 * 稳定键校验（prepare/commit 的错误码如实呈现）。
 */
function batchAnalysisFromNative(
  analysis: ImportBatchConflictAnalysis,
  candidates: ImportCandidate[],
): ImportBatchAnalysis {
  const consumed = new Set<string>();
  const pool = new Map<string, ImportCandidate[]>();
  for (const candidate of [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const key = `${candidate.name.trim().toLowerCase()}|${observedPathKey(candidate.relativeRoot)}`;
    const bucket = pool.get(key);
    if (bucket) bucket.push(candidate);
    else pool.set(key, [candidate]);
  }
  const take = (candidateKey: string, runtimeName: string): ImportCandidate | undefined => {
    const separator = candidateKey.indexOf("|");
    const suffix = separator >= 0 ? candidateKey.slice(separator + 1) : candidateKey;
    const bucket = pool.get(
      `${runtimeName.trim().toLowerCase()}|${observedPathKey(suffix)}`,
    );
    const match = bucket?.find((candidate) => !consumed.has(candidate.id));
    if (match) consumed.add(match.id);
    return match;
  };
  return {
    sameContentGroups: analysis.same_content_groups.flatMap((group) => {
      const keep = take(group.keep_candidate_key, group.normalized_runtime_name);
      if (!keep) return [];
      return [{
        keepCandidateId: keep.id,
        normalizedRuntimeName: group.normalized_runtime_name,
        skipCandidateIds: group.skip_candidate_keys.flatMap((key) => {
          const skip = take(key, group.normalized_runtime_name);
          return skip ? [skip.id] : [];
        }),
      }];
    }),
    sameNameGroups: analysis.same_name_groups.map((group) => ({
      normalizedRuntimeName: group.normalized_runtime_name,
      candidateIds: group.candidate_keys.flatMap((key) => {
        const member = take(key, group.normalized_runtime_name);
        return member ? [member.id] : [];
      }),
    })),
    signature: analysis.signature,
  };
}

function sourceLabel(source: ImportAnalysis["matches"][number]["source"]): string | undefined {
  if (!source) return undefined;
  return source.locator.local_path ?? source.locator.https_url ?? source.locator.git_url;
}

function matchedSkill(match: ImportAnalysis["matches"][number]): ImportMatchedSkill {
  return {
    id: match.skill_id,
    displayName: match.display_name || match.runtime_name,
    runtimeName: match.runtime_name,
    source: sourceLabel(match.source),
  };
}

function preparedImport(result: AppCommandResult) {
  if (result.type !== "prepared_import") {
    throw new Error("native import preparation returned an unexpected result");
  }
  return result.payload;
}

/** W3-1：把 prepare 返回的安全摘要映射为处置环节的展示视图。 */
function securitySummaryView(
  security: PreparedImport["security"],
): ImportSecuritySummaryView {
  const findings: ImportSecurityFindingView[] = (security?.findings ?? []).map((finding) => ({
    code: finding.code,
    file: finding.file,
    lineStart: finding.line_start,
    productLevel: finding.product_level,
  }));
  return {
    checkState: security?.check_state,
    dangerCount: security?.danger_count ?? 0,
    findings,
    level: security?.level ?? "pass",
    warningCount: security?.warning_count ?? 0,
  };
}

function importSummary(result: AppCommandResult) {
  if (result.type !== "import_summary") {
    throw new Error("native import commit returned an unexpected result");
  }
  return result.payload;
}

function importBatchStarted(result: AppCommandResult): string {
  if (result.type !== "import_batch_started") {
    throw new Error("native import batch start returned an unexpected result");
  }
  return result.payload.batch_id;
}

function importBatchFinalized(result: AppCommandResult) {
  if (result.type !== "import_batch_finalized") {
    throw new Error("native import batch finalize returned an unexpected result");
  }
  return result.payload;
}

const discoveredCandidates = new Map<string, NativeImportCandidate>();
function reconstructedCandidate(candidate: ImportCandidate): NativeImportCandidate {
  return {
    absolute_root: candidate.path,
    default_action: "review",
    marker: "SKILL.md",
    ownership: candidate.ownership === "managed"
      ? "central_library"
      : candidate.ownership === "agent_builtin"
        ? "known_agent_target"
        : "arbitrary_local_directory",
    ownership_detail: null,
    relative_root: ".",
    runtime_name: candidate.name,
    source: nativeSource(candidate.source),
  };
}

function nativeCandidateFor(candidate: ImportCandidate): NativeImportCandidate {
  return discoveredCandidates.get(candidate.id) ?? reconstructedCandidate(candidate);
}

export const nativeImportFacade: ImportFacade = {
  parseSource: parseSourceInput,

  async acquireCandidates(source, signal) {
    const descriptor = nativeSource(source);
    if (signal?.aborted) throw new ImportCancelledError();
    const result = await queryApplication({
      type: "discover_import_candidates",
      payload: { source: descriptor },
    });
    if (signal?.aborted) throw new ImportCancelledError();
    const nativeCandidates = queryImportCandidates(result);
    for (const candidate of nativeCandidates) {
      discoveredCandidates.set(candidateId(candidate), candidate);
    }
    return nativeCandidates.map(toCandidate);
  },

  async analyzeConflicts(candidates, onProgress) {
    const conflicts: ImportConflict[] = [];
    let completed = 0;
    // W2-2：批内互检与逐候选库内分析并行发出（展示阶段还没有批次号，
    // batch_id 为 null）。宿主不支持该查询时诚实降级为无批内分组，
    // 不伪造分组，也不让批内分析失败拖垮整个分析阶段。
    // 注意先创建逐候选查询、再发起批内查询：两者并发，调用顺序稳定。
    const analysisQueries = candidates.map((candidate) => queryApplication({
      type: "analyze_import",
      payload: {
        candidate: nativeCandidateFor(candidate),
        tree_hash: null,
      },
    }).then((result) => {
      completed += 1;
      onProgress?.({ candidateId: candidate.id, completed, total: candidates.length });
      return { candidate, analysis: queryImportAnalysis(result) };
    }));
    const batchAnalysisQuery = queryApplication({
      type: "analyze_import_batch",
      payload: {
        batch_id: null,
        candidates: candidates.map(nativeCandidateFor),
      },
    })
      .then(queryImportBatchAnalysis)
      .catch(() => undefined);
    // W3-1：逐候选 prepare 带回安全分级摘要（与后端留存报告同一份发现）
    // 与真实 check_state。prepare 只写会话内存、放弃无残留（后端语义）；
    // 单个候选准备失败诚实降级为无安全摘要 + 徽标保持未检查，不让其
    // 拖垮整个分析阶段——提交期门禁仍由后端错误码把守。经一次微任务
    // 再调用，避免同步抛错打断并发装配。
    const prepareQueries = candidates.map((candidate) =>
      Promise.resolve()
        .then(() => executeCommand({
          type: "prepare_import",
          payload: {
            candidate: nativeCandidateFor(candidate),
            tree_hash: null,
          },
        }))
        .then(preparedImport)
        .catch(() => undefined));
    // 各候选互不依赖，并行分析以避免 N 次串行 IPC 往返。候选数组长度即真实
    // 总数，每个候选查询 resolve 即累计一次真实已完成数；进度只反映已完成的
    // IPC 查询，不做任何估算（OPT-20260914-01）。
    const [analyses, batchAnalysis, prepares] = await Promise.all([
      Promise.all(analysisQueries),
      batchAnalysisQuery,
      Promise.all(prepareQueries),
    ]);
    const security: ImportSecurityPlan = {};
    const preparedCandidates = candidates.map((candidate, index) => {
      const prepared = prepares[index];
      if (!prepared) return candidate;
      if (prepared.security) security[candidate.id] = securitySummaryView(prepared.security);
      const checkState = prepared.security?.check_state;
      // §6.0 债务清偿：候选徽标用 prepare 的真实 check_state 替换硬编码
      // 的“尚未检查”；prepare 失败（无返回）时保持 not_checked。
      return checkState ? { ...candidate, basicCheck: checkState } : candidate;
    });
    for (const { candidate, analysis } of analyses) {
      for (const conflict of analysis.conflicts) {
        if (!conflict.requires_choice) continue;
        const allowedActions = analysis.actions
          .map(actionForDecision)
          .filter((action): action is ImportAction => action !== undefined)
          .filter((action, index, actions) => actions.indexOf(action) === index);
        conflicts.push({
          allowedActions,
          candidateId: candidate.id,
          candidateName: candidate.name,
          candidatePath: candidate.path,
          duplicateKind: analysis.duplicate_kind,
          kind: conflictKind(conflict.kind),
          matchedSkillIds: analysis.matches.map((match) => match.skill_id),
          matchedSkills: analysis.matches
            .filter((match) => match.skill_id === conflict.skill_id)
            .map(matchedSkill),
          required: true,
          summary: conflict.reason_code,
        });
      }
    }
    return {
      candidates: preparedCandidates,
      conflicts,
      governanceGroups: mergeGovernanceGroups(
        analyses.flatMap(({ analysis }) => analysis.governance_groups ?? []),
      ),
      ...(Object.keys(security).length ? { security } : {}),
      ...(batchAnalysis
        ? { batchAnalysis: batchAnalysisFromNative(batchAnalysis, candidates) }
        : {}),
    };
  },

  async commitImport(plan, actions, onProgress, governanceDecision = { group_actions: {}, item_overrides: {} }, dispositions) {
    // 计划 9.3：一次向导提交会话只创建一个批次；每项 commit 复用同一
    // batch_id。批次上下文来自 begin/finalize 与后端回显，绝不从
    // results[0] 偶然取得。
    const batchId = importBatchStarted(
      await executeCommand({ type: "begin_import_batch", payload: {} }),
    );
    // W2-2：提交期重跑批内分析刷新组成签名——analyze 之后批次才存在，
    // 后端按 batch_id 校验签名，组成变化即整批拒绝（绝不假成功）。
    // candidate_key 一律缺省：稳定键由应用层从来源与相对根派生，前端
    // 自造键会破坏批内守卫。
    let batchSignature: string | null = null;
    if (plan.candidates.length > 0) {
      batchSignature = queryImportBatchAnalysis(await queryApplication({
        type: "analyze_import_batch",
        payload: {
          batch_id: batchId,
          candidates: plan.candidates.map(nativeCandidateFor),
        },
      })).signature;
    }
    const results: ImportResult[] = [];
    for (const [index, candidate] of plan.candidates.entries()) {
      onProgress?.({
        candidateId: candidate.id,
        completed: index,
        total: plan.candidates.length,
      });
      const selectedAction = actions[candidate.id];
      let action = selectedAction ?? "copy";
      // W2-2：独立命名只对非跳过项透传（skip 与改名互斥）；空白名视同未填。
      const rawOverride = dispositions?.runtimeNameOverrides?.[candidate.id];
      const rename = selectedAction !== "skip" && rawOverride !== undefined && rawOverride.trim()
        ? rawOverride.trim()
        : null;
      // W3-1：危险级候选的显式安全决策随 commit_import 透传（skip=不导入，
      // 后端按跳过落账；proceed=仍要导入）。未决策的候选不携带该字段——
      // 危险级缺决策由后端以 import.security_decision_required 拒绝该候选。
      const securityDecision = dispositions?.securityDecisions?.[candidate.id];
      try {
        const prepared = preparedImport(await executeCommand({
          type: "prepare_import",
          payload: {
            candidate: nativeCandidateFor(candidate),
            tree_hash: null,
            ...(rename ? { runtime_name_override: rename } : {}),
          },
        }));
        const decision = selectedAction
          ? decisionForAction(selectedAction, prepared.analysis.actions)
          : defaultDecision(prepared.analysis.actions);
        action = actionForDecision(decision) ?? action;
        const summary = importSummary(await executeCommand({
          type: "commit_import",
          payload: {
            decision,
            governance_decision: decisionForPrepared(governanceDecision, prepared.analysis.governance_groups ?? []),
            prepared_import_id: prepared.id,
            batch_id: batchId,
            ...(batchSignature ? { batch_signature: batchSignature } : {}),
            ...(rename && action !== "skip" ? { runtime_name_override: rename } : {}),
            ...(securityDecision ? { security_decision: securityDecision } : {}),
          },
        }));
        results.push(resultForSummary(candidate, action, summary));
      } catch (error) {
        const reasonCode = nativeErrorCode(error) ?? "import.unknown_failure";
        results.push({
          action,
          candidateId: candidate.id,
          message: importErrorMessage(error),
          status: "failed",
          reasonCode,
          // prepare/commit failures never delete the source.  A failed
          // transaction also cleans up the managed copy before returning.
          originalPreserved: true,
          governanceTasks: [],
        });
      }
      onProgress?.({
        candidateId: candidate.id,
        completed: index + 1,
        total: plan.candidates.length,
      });
    }
    // 计划 9.3：终结批次并取回批次级事实。manageable_source_count 由
    // 后端持久化映射计算：Online 等无来源关系的结果不计入（为 0 时
    // 就是 0，前端绝不自行汇总）。
    const finalized = importBatchFinalized(await executeCommand({
      type: "finalize_import_batch",
      payload: { batch_id: batchId },
    }));
    return {
      batch: {
        batchId: finalized.batch_id,
        manageableSourceCount: Number(finalized.manageable_source_count),
      },
      results,
    };
  },

  cancel: () => {
    discoveredCandidates.clear();
    return Promise.resolve();
  },

  async runAiPreChecks(plan) {
    // Step-5 advisory pre-check: stage every candidate exactly like the
    // commit loop does, then run one batched AI safety analysis. Findings
    // never change the deterministic gates; commit re-prepares its own ids.
    const preparedIds: string[] = [];
    const candidateIds: string[] = [];
    // 各候选互不依赖，并行 prepare 以避免 N 次串行 IPC 往返；顺序按原候选顺序保留。
    const preparedList = await Promise.all(plan.candidates.map((candidate) => executeCommand({
      type: "prepare_import",
      payload: {
        candidate: nativeCandidateFor(candidate),
        tree_hash: null,
      },
    }).then(preparedImport)));
    for (const [index, prepared] of preparedList.entries()) {
      preparedIds.push(prepared.id);
      candidateIds.push(plan.candidates[index].id);
    }
    const result: AppCommandResult = await executeCommand({
      type: "run_import_ai_checks",
      payload: { prepared_import_ids: preparedIds },
    });
    if (result.type !== "import_ai_checks_report") {
      throw new Error("run_import_ai_checks returned an unexpected native result.");
    }
    const report = result.payload;
    return {
      model: report.model,
      provider: report.provider,
      requested: report.requested,
      outcomes: report.outcomes.map((outcome, index) => ({
        candidateId: candidateIds[index] ?? outcome.prepared_import_id,
        failureCode: outcome.failure_code ?? null,
        fileCount: outcome.file_count,
        findingCount: outcome.finding_count,
        state: outcome.state,
      })),
    };
  },

  async listLlmProviders() {
    // Task 8：AI 可用性真实信号。与设置页共用同一查询；是否“可用”
    // 由 usableLlmProviderLabel 判定（已启用 + 本地或凭据已配置）。
    const result = await queryApplication({ type: "list_llm_providers" });
    if (result.type !== "llm_providers") {
      throw new Error("list_llm_providers returned an unexpected native result.");
    }
    return result.payload;
  },
};
