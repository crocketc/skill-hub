import type { IconName } from "../../../ui/Icon";

/**
 * 卡片来源类型：决定来源图标；新增类型按向后兼容方式追加到联合类型，
 * 未知运行时值回退到中性图标，不抛错。
 */
export type SkillCardSourceType = "local" | "online" | "repo" | "lock";

/** 状态语气；状态始终是“标记+文字”，不单靠颜色表达。 */
export type SkillCardStatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface SkillCardStatus {
  /** 状态文字（必填，已按当前语言本地化）。 */
  label: string;
  tone: SkillCardStatusTone;
  /** 可选测试定位锚点（渲染为 `data-testid`）。 */
  testId?: string;
}

/**
 * 共享 Skill 卡片的可证实数据模型（T2 冻结契约，T3-B 只消费或向后兼容扩展）。
 *
 * 只允许真实来源可验证的字段：ID、名称、来源类型、来源标签/地址、
 * 可选描述、可选数量元数据、可选分支/目录定位、状态。
 * 不包含作者、评分、兼容 Agent 或任何需要伪造才能展示的字段；
 * 来源未提供的可选字段必须省略，由消费方如实留空。
 * 所有展示字符串在消费方完成本地化后传入。
 */
export interface SkillCardViewModel {
  /** 唯一标识：渲染为 `data-skill-card`，用于测试定位与 key。 */
  id: string;
  /** 显示名称（卡片标题语义）。 */
  name: string;
  /**
   * 可选副名（P1-10 向后兼容扩展）：标题下方小一号展示，用于别名场景下
   * 同时呈现目录原名；缺省时省略，渲染与 T2 冻结契约一致。
   */
  subtitle?: string;
  /** 来源类型：映射来源装饰图标。 */
  sourceType: SkillCardSourceType;
  /** 来源标签（如 “来源：skills.sh” 或 “owner/repo@main”）。 */
  sourceLabel: string;
  /** 可选来源地址：只作为事实展示，不承担打开动作。 */
  sourceAddress?: string;
  /** 可选描述；来源缺失时必须省略，不伪造。 */
  description?: string;
  /** 可选分支/目录定位（如 “@main” 或 “skills/pdf”）。 */
  location?: string;
  /** 可选本地化数量/元数据行（如 “安装次数：42”）。 */
  metrics?: string[];
  /**
   * 可选状态列表（已在库/下载中/不可安装/AI 扩展命中等）；全部如实并列展示，
   * 因为一条结果可同时命中多个可证实状态。
   */
  statuses?: SkillCardStatus[];
}

/** 来源类型 → 功能图标注册表名；与品牌 Logo 注册表严格分离。 */
const sourceIcons: Record<SkillCardSourceType, IconName> = {
  local: "overview",
  online: "open-external",
  repo: "import",
  lock: "operations",
};

/** 解析来源图标；未知来源类型回退中性图标，保证向后兼容。 */
export function skillCardSourceIcon(sourceType: SkillCardSourceType): IconName {
  return sourceIcons[sourceType] ?? "info";
}
