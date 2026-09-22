import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";
import { useOverviewRelationshipSummaries } from "../overview/RelationshipThumbnail";
import { PageFrame } from "../../ui/PageFrame";
import { DataState } from "../../ui/DataState";
import type { RelationshipsFacade } from "./api";

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

const NAV_ITEMS = [
  { href: "/relationships", scope: "graph", titleKey: TITLE_KEYS.graph },
  { href: "/relationships/decisions", scope: "decisions", titleKey: TITLE_KEYS.decisions },
  { href: "/relationships/governance", scope: "governance", titleKey: TITLE_KEYS.governance },
] as const satisfies ReadonlyArray<{
  href: string;
  scope: RelationshipsPageScope;
  titleKey: string;
}>;

interface RelationshipsNavProps {
  /** 测试接缝；缺省原生只读门面，查询经共享 key 与概览、页面去重。 */
  facade?: RelationshipsFacade;
}

/**
 * DEV-23：关系模块三页共用页内导航。三个子页此前只能从概览卡片或直达 URL
 * 进入，页内无任何入口。页签计数与概览缩略带同源（`useOverviewRelationshipSummaries`
 * 的共享 query key）：图谱=有关系事实的 Skill 数、冲突处理=待确认冲突数、
 * 治理=已建立关系边数；查询未落地时以「–」占位，绝不把 0 当作未加载。
 */
function RelationshipsNav({ facade }: RelationshipsNavProps) {
  const { t } = useTranslation();
  const { candidatesQuery, conflictsQuery, governanceQuery } =
    useOverviewRelationshipSummaries(facade);

  const counts: Record<RelationshipsPageScope, number | null> = {
    graph: candidatesQuery.isSuccess ? candidatesQuery.data?.length ?? 0 : null,
    decisions: conflictsQuery.isSuccess ? conflictsQuery.data?.cases.length ?? 0 : null,
    governance: governanceQuery.isSuccess ? governanceQuery.data?.total ?? 0 : null,
  };

  return (
    <nav aria-label={t("relationships.sectionNavLabel")} className="sh-relationships__nav">
      {NAV_ITEMS.map((item) => (
        <NavLink
          className={({ isActive }) => [
            "sh-relationships__nav-link",
            "sh-relationships__nav-link--title-scale",
            isActive ? "sh-relationships__nav-link--active" : "",
            item.scope === "decisions" && (counts.decisions ?? 0) > 0
              ? "sh-relationships__nav-link--alert"
              : "",
          ].filter(Boolean).join(" ")}
          key={item.scope}
          to={item.href}
        >
          <span>{t(item.titleKey)}</span>
          <span
            aria-hidden="true"
            className="sh-relationships__nav-count"
            data-testid={`relationships-nav-count-${item.scope}`}
          >
            {counts[item.scope] ?? "–"}
          </span>
        </NavLink>
      ))}
    </nav>
  );
}

interface RelationshipsLayoutProps {
  scope: RelationshipsPageScope;
  /** 页面内容；未提供时展示诚实的“尚未提供”占位（业务画布由后续任务接入）。 */
  children?: ReactNode;
  /** 页签计数的数据源接缝；缺省原生只读门面（与页面/概览共享查询）。 */
  facade?: RelationshipsFacade;
}

/**
 * 技能关系模块三页共用的壳层（任务 5）：模块标题由 AppShell 顶栏承载，
 * 三个工作区名称作为页签展示。画布/工作台由任务 6/7/8 填充。
 * DEV-23 起壳层同时承载页内页签导航：三页共享同一份计数事实，
 * 概览卡片深链入口保持不变；DEV-67 避免当前路由标题与页签重复。
 */
export function RelationshipsLayout({ scope, children, facade }: RelationshipsLayoutProps) {
  const { t } = useTranslation();

  return (
    <PageFrame fill width="wide">
      <div className="sh-relationships">
        <RelationshipsNav facade={facade} />
        {children ?? <DataState message={t(PLACEHOLDER_KEYS[scope])} state="unavailable" />}
      </div>
    </PageFrame>
  );
}
