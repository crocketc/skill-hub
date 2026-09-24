import { RelationshipsLayout } from "./RelationshipsLayout";
import { SkillGraphPage } from "./graph/SkillGraphPage";
import { ConflictDecisionPage } from "./decisions/ConflictDecisionPage";
import { RelationshipGovernancePage } from "./governance/RelationshipGovernancePage";
import { GovernanceHistoryPage } from "./governance/GovernanceHistoryPage";

/**
 * 任务 5 的三条懒加载路由入口。业务画布已分别由任务 6（图谱）、任务 7（冲突处理）、
 * 任务 8（关系治理）接入；路由与导航契约保持不变。
 * 模式说明：图谱与冲突处理由本文件包裹 RelationshipsLayout；治理工作台
 * （任务 8）因需把自身 props 线程化进布局而在组件内部自持 RelationshipsLayout
 * （scope 契约一致，二者等价）。
 */
export function RelationshipsGraphPage() {
  return (
    <RelationshipsLayout scope="graph">
      <SkillGraphPage />
    </RelationshipsLayout>
  );
}

export function RelationshipsDecisionsPage() {
  return (
    <RelationshipsLayout scope="decisions">
      <ConflictDecisionPage />
    </RelationshipsLayout>
  );
}

export function RelationshipsGovernancePage() {
  return <RelationshipGovernancePage />;
}

export function RelationshipsGovernanceHistoryPage() {
  return <GovernanceHistoryPage />;
}
