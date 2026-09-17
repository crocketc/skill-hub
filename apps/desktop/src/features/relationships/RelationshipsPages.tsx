import { RelationshipsLayout } from "./RelationshipsLayout";
import { RelationshipGovernancePage } from "./governance/RelationshipGovernancePage";

/**
 * 任务 5 的三条懒加载路由入口。业务画布由任务 6（图谱）、任务 7（冲突处理）、
 * 任务 8（关系治理）分别替换 children；路由与导航契约保持不变。
 * 任务 8 的治理工作台已接入治理插槽；图谱/冲突处理仍为占位。
 */
export function RelationshipsGraphPage() {
  return <RelationshipsLayout scope="graph" />;
}

export function RelationshipsDecisionsPage() {
  return <RelationshipsLayout scope="decisions" />;
}

export function RelationshipsGovernancePage() {
  return <RelationshipGovernancePage />;
}
