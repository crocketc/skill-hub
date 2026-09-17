import type {
  AnalyzeConflictScope,
  ConflictAnalysis,
  ConflictResolutionOutcome,
  ConflictWorkspace,
  ResolveConflictCase,
} from "../../../api/bindings";
import { executeCommand, queryApplication } from "../../../api/bindings";
import { usableLlmProviderLabel } from "../../settings/llmApi";
import type { RelationshipConflictsParams } from "../api";

export type {
  AnalyzeConflictScope,
  ConflictAnalysis,
  ConflictResolutionOutcome,
  ConflictWorkspace,
  ResolveConflictCase,
};

/**
 * 冲突处理工作台的门面（任务 7）。工作台读取是任务 2 的只读投影；
 * AI 分析与决定写入是两条显式命令，全部由页面经统一执行桥调用，
 * 门面本身不触发任何扫描或写操作。
 */
export interface ConflictDecisionsFacade {
  getConflictWorkspace(params?: RelationshipConflictsParams): Promise<ConflictWorkspace>;
  /** 与设置页同一真实 LLM 供应商判定（已启用 + 本地或凭据已配置）。 */
  isAiAvailable(): Promise<boolean>;
  analyzeConflict(scope: AnalyzeConflictScope): Promise<ConflictAnalysis>;
  resolveConflictCase(command: ResolveConflictCase): Promise<ConflictResolutionOutcome>;
}

function unexpectedResult(queryType: string): never {
  throw new Error(`${queryType} returned an unexpected native result.`);
}

export const nativeConflictDecisionsFacade: ConflictDecisionsFacade = {
  async getConflictWorkspace() {
    const result = await queryApplication({
      type: "get_conflict_workspace",
      payload: null,
    });
    if (result.type !== "conflict_workspace") {
      return unexpectedResult("get_conflict_workspace");
    }
    return result.payload;
  },
  async isAiAvailable() {
    const result = await queryApplication({ type: "list_llm_providers" });
    if (result.type !== "llm_providers") return unexpectedResult("list_llm_providers");
    return usableLlmProviderLabel(result.payload) !== "";
  },
  async analyzeConflict(scope) {
    const result = await executeCommand({
      type: "analyze_conflict",
      payload: { scope },
    });
    if (result.type !== "conflict_analysis") {
      return unexpectedResult("analyze_conflict");
    }
    return result.payload;
  },
  async resolveConflictCase(command) {
    const result = await executeCommand({
      type: "resolve_conflict_case",
      payload: command,
    });
    if (result.type !== "conflict_resolved") {
      return unexpectedResult("resolve_conflict_case");
    }
    return result.payload;
  },
};
