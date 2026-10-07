import type {
  DeploymentRelationFact,
  RelationGovernanceRow,
} from "../../api/bindings";
import { relationIdOf } from "../relationships/governance/api";

/**
 * 使用去向卡的呈现模型（W3-5）：全部字段来自治理清单行事实，
 * 前端不再自备样例数据，也不在前端翻转接管状态（§7.8）。
 */
export interface UsageDestinationCard {
  relationId: string;
  path: string;
  targetKind: "agent" | "project" | "shared_directory";
  /** 卡片身份品牌；共享目录卡收集同一物理路径的全部消费者品牌。 */
  agentClientIds: string[];
  takenOver: boolean;
  /** 行内健康证据非空：卡片说明必须提示到关系治理检查，不靠颜色单独传递。 */
  unhealthy: boolean;
}

type DeploymentRow = RelationGovernanceRow & {
  relation: { kind: "deployment"; fact: DeploymentRelationFact };
};

/** 使用去向分区状态：加载、清单不可用与就绪三态，绝不静默呈现为空。 */
export type UsageDestinationsState =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ready"; cards: UsageDestinationCard[] };

function isDeploymentRow(row: RelationGovernanceRow): row is DeploymentRow {
  return row.relation.kind === "deployment";
}

function targetKindOf(row: DeploymentRow): UsageDestinationCard["targetKind"] {
  // 已登记并验证过的目标以 target_identity 为准；缺失时按关系形态回退。
  if (row.target_identity) return row.target_identity.target_kind;
  const relationship = row.relation.fact.relationship;
  return relationship === "shared_directory_read" || relationship === "shared_directory_reference"
    ? "shared_directory"
    : "agent";
}

/** 治理清单（单一事实来源）→ 使用去向卡：只保留部署类使用关系。 */
export function usageDestinationCards(
  rows: readonly RelationGovernanceRow[],
): UsageDestinationCard[] {
  const deploymentRows = rows.filter(isDeploymentRow);
  // 共享目录只计一个物理去向：同一 path_key 的全部行互为消费者，
  // 品牌集合来自清单事实本身，不在前端猜测。
  const consumersByPathKey = new Map<string, string[]>();
  for (const row of deploymentRows) {
    const fact = row.relation.fact;
    const consumers = consumersByPathKey.get(fact.path_key) ?? [];
    if (!consumers.includes(fact.agent_client_id)) consumers.push(fact.agent_client_id);
    consumersByPathKey.set(fact.path_key, consumers);
  }
  return deploymentRows.map((row) => {
    const fact = row.relation.fact;
    return {
      relationId: relationIdOf(row.relation),
      path: fact.path,
      targetKind: targetKindOf(row),
      agentClientIds: consumersByPathKey.get(fact.path_key) ?? [fact.agent_client_id],
      takenOver: row.governance.management_status === "taken_over",
      unhealthy: row.governance.health_reasons.length > 0,
    };
  });
}

/** 项目卡标题从路径推导（`<项目>/skills/<skill>` 的上一段）；推导不出时不伪造名称。 */
export function projectDisplayName(path: string): string | null {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.length >= 3 && segments[segments.length - 2] === "skills") {
    return segments[segments.length - 3] || null;
  }
  return null;
}
