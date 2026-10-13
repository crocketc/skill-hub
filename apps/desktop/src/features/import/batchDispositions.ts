import type {
  ImportAction,
  ImportBatchAnalysis,
  ImportConflict,
} from "./api";

/**
 * 批内处置的纯规则（W2-2 / FB-007）：
 * - 同名组成员须逐项选择独立导入或跳过；独立导入保留发现时的名称。
 * - 未选择处置前，提交在 UI 层先行拦截。
 * - 同内容组给出“保留一项导入、其余跳过”的建议动作（可改）。
 */

/**
 * 仍未显式处置的同名组成员 id（按组内顺序）。跳过或独立导入才算处置完成；
 * copy、takeover 等其他动作对批内同名成员不算处置（与后端
 * import.same_name_disposition_required 的口径一致）。
 */
export function pendingBatchDispositionIds(
  batch: ImportBatchAnalysis,
  actions: Readonly<Record<string, ImportAction>>,
): string[] {
  const pending: string[] = [];
  for (const group of batch.sameNameGroups) {
    for (const memberId of group.candidateIds) {
      const action = actions[memberId];
      if (action !== "skip" && action !== "independent") pending.push(memberId);
    }
  }
  return pending;
}

/**
 * 同内容组的建议动作：保留项=复制，其余=跳过。保留项自身还有必答的库内
 * 冲突时不预选复制（由库内冲突行主导），跳过建议照常给出。同名组成员
 * 不在此播种——它们必须逐项显式处置，没有任何静默默认。
 */
export function batchSuggestionActions(
  batch: ImportBatchAnalysis,
  conflicts: readonly ImportConflict[],
): Partial<Record<string, ImportAction>> {
  const suggestions: Partial<Record<string, ImportAction>> = {};
  const owingRequiredDecision = new Set(
    conflicts
      .filter((conflict) => conflict.required)
      .map((conflict) => conflict.candidateId),
  );
  for (const group of batch.sameContentGroups) {
    if (!owingRequiredDecision.has(group.keepCandidateId)) {
      suggestions[group.keepCandidateId] = "copy";
    }
    for (const skipId of group.skipCandidateIds) {
      suggestions[skipId] = "skip";
    }
  }
  return suggestions;
}
