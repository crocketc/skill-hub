import { RelationshipsLayout } from "./RelationshipsLayout";
import { SkillGraphPage } from "./graph/SkillGraphPage";

/**
 * 任务 5 的三条懒加载路由入口。图谱画布（任务 6）已接入 graph 槽位；
 * 冲突处理与关系治理画布由任务 7/8 分别替换 children；路由与导航契约保持不变。
 */
export function RelationshipsGraphPage() {
  return (
    <RelationshipsLayout scope="graph">
      <SkillGraphPage />
    </RelationshipsLayout>
  );
}

export function RelationshipsDecisionsPage() {
  return <RelationshipsLayout scope="decisions" />;
}

export function RelationshipsGovernancePage() {
  return <RelationshipsLayout scope="governance" />;
}
