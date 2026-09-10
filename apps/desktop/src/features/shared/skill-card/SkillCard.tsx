import type { ReactNode } from "react";
import { Icon } from "../../../ui/Icon";
import { StatusBadge } from "../../../ui/StatusBadge";
import { skillCardSourceIcon, type SkillCardViewModel } from "./SkillCardViewModel";
import "./skill-card.css";

export interface SkillCardProps {
  /** 卡片数据；可选字段缺失时如实省略对应区域。 */
  skill: SkillCardViewModel;
  /** 主操作插槽（如“下载并导入”按钮）；渲染在操作区次位。 */
  primaryAction?: ReactNode;
  /** 次操作插槽（如“查看”链接）；渲染在操作区首位。 */
  secondaryAction?: ReactNode;
  /**
   * 卡片标题层级。发现子页的模块标题是 `h2`，结果卡片默认 `h3`；
   * 顶层浏览页（无更高级标题）可显式传 `h2`。
   */
  headingLevel?: "h2" | "h3" | "h4";
}

/**
 * 共享 Skill 卡片（T2 冻结契约）。只负责展示语义：
 * 标题保持 heading、来源是一行事实文本、描述最多三行、
 * 状态是“标记+文字”、操作区稳定在卡片底部。
 * 整卡不可点击；链接与按钮是消费者传入的独立语义插槽。
 */
export function SkillCard({
  headingLevel: Heading = "h3",
  primaryAction,
  secondaryAction,
  skill,
}: SkillCardProps) {
  const hasMeta = Boolean(
    skill.location || (skill.metrics && skill.metrics.length > 0) ||
      (skill.statuses && skill.statuses.length > 0),
  );

  return (
    <article className="sh-skill-card" data-skill-card={skill.id}>
      <div className="sh-skill-card__identity">
        <span aria-hidden="true" className="sh-skill-card__source-icon">
          <Icon name={skillCardSourceIcon(skill.sourceType)} size={20} />
        </span>
        <Heading className="sh-skill-card__title">{skill.name}</Heading>
      </div>
      <p className="sh-skill-card__source">
        <span className="sh-skill-card__source-label">{skill.sourceLabel}</span>
        {skill.sourceAddress ? (
          <span className="sh-skill-card__source-address">{skill.sourceAddress}</span>
        ) : null}
      </p>
      {skill.description ? (
        <p className="sh-skill-card__description" title={skill.description}>
          {skill.description}
        </p>
      ) : null}
      {hasMeta ? (
        <ul className="sh-skill-card__meta">
          {skill.location ? (
            <li className="sh-skill-card__meta-item">{skill.location}</li>
          ) : null}
          {(skill.metrics ?? []).map((metric, index) => (
            <li className="sh-skill-card__meta-item" key={`${metric}-${index}`}>
              {metric}
            </li>
          ))}
          {(skill.statuses ?? []).map((status, index) => (
            <li className="sh-skill-card__meta-item" key={`${status.label}-${index}`}>
              <span data-testid={status.testId}>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {primaryAction || secondaryAction ? (
        <div className="sh-skill-card__actions">
          {secondaryAction}
          {primaryAction}
        </div>
      ) : null}
    </article>
  );
}
