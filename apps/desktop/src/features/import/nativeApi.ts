import {
  executeCommand,
  queryApplication,
  type AppCommandResult,
  type AppQueryResult,
  type ImportAnalysis,
  type ImportCandidate as NativeImportCandidate,
  type ImportDecision,
} from "../../api/bindings";
import { keyedMessage } from "../../api/nativeErrors";
import {
  ImportCancelledError,
  parseSourceInput,
  type ImportAction,
  type ImportCandidate,
  type ImportConflict,
  type ImportFacade,
  type ImportMatchedSkill,
  type ImportResult,
  type SourceDescriptor,
} from "./api";
import { normalizeWindowsPath } from "../../platform/directoryPicker";

function nativeSource(source: SourceDescriptor) {
  if (source.kind !== "local_path") {
    throw new Error("import.remote_download_not_wired");
  }
  return { kind: "local" as const, locator: { local_path: normalizeWindowsPath(source.displayTarget) } };
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
    ownership: ownership(candidate.ownership),
    path: normalizeWindowsPath(candidate.absolute_root),
    source: {
      displayTarget: normalizeWindowsPath(candidate.source.locator.local_path ?? candidate.absolute_root),
      executesCommand: false,
      input: normalizeWindowsPath(candidate.source.locator.local_path ?? candidate.absolute_root),
      kind: "local_path",
    },
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
  if (action === "skip") {
    return { action, candidateId: candidate.id, message: "importWorkflow.commitMessages.skipped", status: "skipped" };
  }
  return {
    action,
    candidateId: candidate.id,
    message: item?.skill_id
      ? "importWorkflow.commitMessages.imported"
      : "importWorkflow.commitMessages.noDetail",
    status: result.committed ? "succeeded" : "failed",
  };
}

function importErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "import.import_failed";
  if (typeof error === "string") {
    try {
      return importErrorMessage(JSON.parse(error) as unknown);
    } catch {
      return error;
    }
  }
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown; params?: unknown };
    const code = typeof record.code === "string" ? record.code : null;
    const message = typeof record.message === "string" ? record.message : null;
    if (code) {
      // 结构化错误码优先映射为 i18n key，由 ImportSummary 的 t() 渲染成
      // 可读文案；未知码兜底为通用可读文案——裸码不允许直达用户界面，
      // 码本身保留在操作记录（error_code）里供诊断。
      const reason = typeof record.params === "object" && record.params !== null
        && typeof (record.params as { reason?: unknown }).reason === "string"
        ? (record.params as { reason: string }).reason
        : undefined;
      return keyedMessage(code, reason) ?? "importWorkflow.errors.unknown";
    }
    if (message) return message;
  }
  return "import.import_failed";
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

function importSummary(result: AppCommandResult) {
  if (result.type !== "import_summary") {
    throw new Error("native import commit returned an unexpected result");
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

  async analyzeConflicts(candidates) {
    const conflicts: ImportConflict[] = [];
    // 各候选互不依赖，并行分析以避免 N 次串行 IPC 往返。
    const analyses = await Promise.all(candidates.map((candidate) => queryApplication({
      type: "analyze_import",
      payload: {
        candidate: nativeCandidateFor(candidate),
        tree_hash: null,
      },
    }).then((result) => ({ candidate, analysis: queryImportAnalysis(result) }))));
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
    return { candidates, conflicts };
  },

  async commitImport(plan, actions, onProgress) {
    const results: ImportResult[] = [];
    for (const [index, candidate] of plan.candidates.entries()) {
      onProgress?.({
        candidateId: candidate.id,
        completed: index,
        total: plan.candidates.length,
      });
      const selectedAction = actions[candidate.id];
      let action = selectedAction ?? "copy";
      try {
        const prepared = preparedImport(await executeCommand({
          type: "prepare_import",
          payload: {
            candidate: nativeCandidateFor(candidate),
            tree_hash: null,
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
            prepared_import_id: prepared.id,
          },
        }));
        results.push(resultForSummary(candidate, action, summary));
      } catch (error) {
        results.push({
          action,
          candidateId: candidate.id,
          message: importErrorMessage(error),
          status: "failed",
        });
      }
      onProgress?.({
        candidateId: candidate.id,
        completed: index + 1,
        total: plan.candidates.length,
      });
    }
    return results;
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
};
