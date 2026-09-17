import { useCallback, useMemo } from "react";
import { useLocation } from "react-router-dom";

/**
 * 关系页回退状态（任务 5）：仅滚动、画布坐标等非 URL 状态走 session 存储，
 * 且必须按来源（scope）与历史条目双重隔离；可复现状态（skillId、筛选、
 * 类别、冲突 ID）一律由 URL 查询参数承载，不进入这里。
 */
export type RelationshipsReturnStateScope = "graph" | "decisions" | "governance";

export interface RelationshipsReturnState {
  filters?: Record<string, string>;
  /** 画布视口（平移/缩放）；仅图谱 scope 使用。 */
  viewport?: { x: number; y: number; zoom: number };
  /** 列表滚动位置；仅治理/冲突 scope 使用。 */
  scrollY?: number;
  /** 选中的行/边 ID；仅治理 scope 使用。 */
  selectedId?: string;
  /** 批量勾选的关系边 ID（任务 8）；仅治理 scope 使用。 */
  selectedIds?: string[];
}

const STORAGE_PREFIX = "skillhub:relationships:return-state";

export function relationshipsReturnStateStorageKey(
  scope: RelationshipsReturnStateScope,
  entryKey: string,
): string {
  return `${STORAGE_PREFIX}:${scope}:${entryKey}`;
}

function readStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // 某些嵌入环境禁用 session 存储：回退状态静默退化为“不恢复”。
    return null;
  }
}

export function saveRelationshipsReturnState(
  scope: RelationshipsReturnStateScope,
  entryKey: string,
  state: RelationshipsReturnState,
): void {
  const store = readStore();
  store?.setItem(relationshipsReturnStateStorageKey(scope, entryKey), JSON.stringify(state));
}

export function readRelationshipsReturnState(
  scope: RelationshipsReturnStateScope,
  entryKey: string,
): RelationshipsReturnState | null {
  const store = readStore();
  const raw = store?.getItem(relationshipsReturnStateStorageKey(scope, entryKey));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as RelationshipsReturnState;
  } catch {
    return null;
  }
}

export function clearRelationshipsReturnState(
  scope: RelationshipsReturnStateScope,
  entryKey: string,
): void {
  readStore()?.removeItem(relationshipsReturnStateStorageKey(scope, entryKey));
}

export interface RelationshipsReturnStateControl {
  /** 当前历史条目键；保存/恢复都以它为隔离维度。 */
  entryKey: string;
  /** 挂载时可用的已保存状态（同一条目回退时非空）。 */
  initialState: RelationshipsReturnState | null;
  saveState: (state: RelationshipsReturnState) => void;
  clearState: () => void;
}

/** 页面级 hook：图谱/治理/冲突页用它保存与恢复各自的非 URL 视图状态。 */
export function useRelationshipsReturnState(
  scope: RelationshipsReturnStateScope,
): RelationshipsReturnStateControl {
  const location = useLocation();
  const entryKey = location.key;
  const initialState = useMemo(
    () => readRelationshipsReturnState(scope, entryKey),
    [scope, entryKey],
  );
  const saveState = useCallback(
    (state: RelationshipsReturnState) => saveRelationshipsReturnState(scope, entryKey, state),
    [scope, entryKey],
  );
  const clearState = useCallback(
    () => clearRelationshipsReturnState(scope, entryKey),
    [scope, entryKey],
  );
  return { entryKey, initialState, saveState, clearState };
}
