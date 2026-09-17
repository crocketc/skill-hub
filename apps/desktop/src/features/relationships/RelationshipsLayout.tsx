import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { DataState } from "../../ui/DataState";

export type RelationshipsPageScope = "graph" | "decisions" | "governance";

const TITLE_KEYS = {
  graph: "relationships.graph.title",
  decisions: "relationships.decisions.title",
  governance: "relationships.governance.title",
} as const satisfies Record<RelationshipsPageScope, string>;

const PLACEHOLDER_KEYS = {
  graph: "relationships.graph.placeholder",
  decisions: "relationships.decisions.placeholder",
  governance: "relationships.governance.placeholder",
} as const satisfies Record<RelationshipsPageScope, string>;

interface RelationshipsLayoutProps {
  scope: RelationshipsPageScope;
  /** 页面内容；未提供时展示诚实的“尚未提供”占位（业务画布由后续任务接入）。 */
  children?: ReactNode;
}

/**
 * 技能关系模块三页共用的壳层（任务 5）：模块页自持 route-level h1
 * （顶栏标题自 2026-09-17 起不再是 heading），画布/工作台由任务 6/7/8 填充。
 */
export function RelationshipsLayout({ scope, children }: RelationshipsLayoutProps) {
  const { t } = useTranslation();

  return (
    <PageFrame width="wide">
      <div className="sh-relationships">
        <PageHeader headingLevel="h1" title={t(TITLE_KEYS[scope])} />
        {children ?? <DataState message={t(PLACEHOLDER_KEYS[scope])} state="unavailable" />}
      </div>
    </PageFrame>
  );
}
