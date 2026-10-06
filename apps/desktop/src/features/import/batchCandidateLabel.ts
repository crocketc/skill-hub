/**
 * 批内展示标签：候选 id → 名称与来源路径。原为 ConflictResolution.tsx 的
 * 私有类型；安全决策区与批内分组区搬迁为独立组件后共享此定义（内容不变）。
 */
export interface BatchCandidateLabel {
  name: string;
  path?: string | null;
}
