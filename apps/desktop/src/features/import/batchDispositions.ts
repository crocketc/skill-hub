import type {
  ImportAction,
  ImportBatchAnalysis,
  ImportCandidate,
  ImportConflict,
} from "./api";

/**
 * 批内处置的纯规则（W2-2 / FB-007）：
 * - 独立命名即时校验：镜像后端 `normalize_runtime_name`（trim + 小写），
 *   依次对照同名组名、批内其他候选发现名、同组兄弟已填改名与库内已展示
 *   冲突名；这只是前端即时反馈，最终裁决仍由 prepare/commit 的错误码给出，
 *   界面必须如实映射，不得把校验说成保证。
 * - 同名组成员未显式处置（跳过或有效独立命名）前，提交在 UI 层先行拦截。
 * - 同内容组给出“保留一项导入、其余跳过”的建议动作（可改）。
 */

/** 与后端 normalize_runtime_name 一致：trim + 小写，仅用于比较。 */
export function normalizeRuntimeName(value: string): string {
  return value.trim().toLowerCase();
}

export type OverrideCollision = "empty" | "batch" | "library";

export interface OverrideNameCollisionInput {
  /** 正在校验的候选项。 */
  candidateId: string;
  /** 该项所在同名组的全部成员（含自己）。 */
  groupCandidateIds: readonly string[];
  /** 同名组的归一化名（后端分析给出）。 */
  normalizedGroupName: string;
  /** 批内全部候选 id → 展示名。 */
  candidateNames: Readonly<Record<string, string>>;
  /** 该项库内冲突行已展示的 runtime 名。 */
  libraryRuntimeNames: readonly string[];
  /** 批内当前已填写的其他改名（含同组兄弟）。 */
  overrides: Readonly<Record<string, string>>;
  /** 用户输入。 */
  value: string;
}

export function overrideNameCollision(
  input: OverrideNameCollisionInput,
): OverrideCollision | null {
  const normalized = normalizeRuntimeName(input.value);
  if (!normalized) return "empty";
  if (normalized === normalizeRuntimeName(input.normalizedGroupName)) return "batch";
  for (const [candidateId, name] of Object.entries(input.candidateNames)) {
    if (candidateId === input.candidateId) continue;
    if (normalizeRuntimeName(name) === normalized) return "batch";
  }
  for (const memberId of input.groupCandidateIds) {
    if (memberId === input.candidateId) continue;
    const sibling = input.overrides[memberId];
    if (sibling !== undefined && normalizeRuntimeName(sibling) === normalized) {
      return "batch";
    }
  }
  for (const libraryName of input.libraryRuntimeNames) {
    if (normalizeRuntimeName(libraryName) === normalized) return "library";
  }
  return null;
}

/**
 * 仍未显式处置的同名组成员 id（按组内顺序）。跳过或“独立 + 有效新名”才算
 * 处置完成；copy、takeover 等其他动作对批内同名成员不算处置（与后端
 * import.same_name_disposition_required 的口径一致）。
 */
export function pendingBatchDispositionIds(
  batch: ImportBatchAnalysis,
  conflicts: readonly ImportConflict[],
  candidates: readonly ImportCandidate[],
  actions: Readonly<Record<string, ImportAction>>,
  overrides: Readonly<Record<string, string>>,
): string[] {
  const pending: string[] = [];
  const candidateNames = Object.fromEntries(
    candidates.map((candidate) => [candidate.id, candidate.name]),
  );
  for (const group of batch.sameNameGroups) {
    // 先到先得：组内按顺序结算，前面成员已成立的新名对后面成员是占用名
    //（与后端按序提交的结果一致）；UI 的即时校验仍是对称对照全部输入。
    const accepted: Record<string, string> = {};
    for (const memberId of group.candidateIds) {
      const action = actions[memberId];
      if (action === "skip") continue;
      if (action === "independent") {
        const libraryRuntimeNames = conflicts
          .filter((conflict) => conflict.candidateId === memberId)
          .flatMap((conflict) =>
            (conflict.matchedSkills ?? []).map((skill) => skill.runtimeName),
          );
        const collision = overrideNameCollision({
          candidateId: memberId,
          groupCandidateIds: group.candidateIds,
          normalizedGroupName: group.normalizedRuntimeName,
          candidateNames,
          libraryRuntimeNames,
          overrides: accepted,
          value: overrides[memberId] ?? "",
        });
        if (collision === null) {
          accepted[memberId] = overrides[memberId] ?? "";
          continue;
        }
      }
      pending.push(memberId);
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
