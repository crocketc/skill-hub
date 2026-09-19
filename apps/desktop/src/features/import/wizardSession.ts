import type { ImportCandidate } from "./api";

/**
 * DEV-12：标准导入向导的会话内扫描事实——扫描结果（逐来源候选与状态）、
 * 候选清单与已勾选候选。模块级单例只在本次应用会话内存续：向导因路由
 * 切换被卸载后再次进入时，步骤与勾选原样恢复；真正提交导入或清空来源
 * 才作废。onboarding 变体不经过此存储（其流程由初始化接管）。
 */

export interface WizardSessionSnapshot {
  /** 保存时的已选来源；恢复前必须与当前已选来源一致，否则作废。 */
  sources: string[];
  candidates: ImportCandidate[];
  candidatesBySource: Array<{ source: string; candidates: ImportCandidate[] }>;
  sourceResults: Array<{ source: string; status: ImportCandidateScanStatus }>;
  selectedIds: string[];
}

export interface ImportCandidateScanStatus {
  kind: "unscanned" | "scanning" | "scanned" | "failed";
  count?: number;
  reason?: string;
}

let snapshot: WizardSessionSnapshot | null = null;

export function saveWizardSession(next: WizardSessionSnapshot): void {
  snapshot = {
    ...next,
    sources: [...next.sources],
    candidates: [...next.candidates],
    candidatesBySource: next.candidatesBySource.map((entry) => ({
      source: entry.source,
      candidates: [...entry.candidates],
    })),
    sourceResults: next.sourceResults.map((entry) => ({ ...entry })),
    selectedIds: [...next.selectedIds],
  };
}

export function readWizardSession(): WizardSessionSnapshot | null {
  return snapshot ? { ...snapshot } : null;
}

export function clearWizardSession(): void {
  snapshot = null;
}
