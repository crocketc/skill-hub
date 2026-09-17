import { RelationshipsLayout } from "./RelationshipsLayout";

/**
 * 任务 5 的三条懒加载路由入口。业务画布由任务 6（图谱）、任务 7（冲突处理）、
 * 任务 8（关系治理）分别替换 children；路由与导航契约保持不变。
 */
export function RelationshipsGraphPage() {
  return <RelationshipsLayout scope="graph" />;
}

export function RelationshipsDecisionsPage() {
  return <RelationshipsLayout scope="decisions" />;
}

export function RelationshipsGovernancePage() {
  return <RelationshipsLayout scope="governance" />;
}
