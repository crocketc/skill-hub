import { normalizeBrandKey } from "../../ui/BrandTag";
import {
  inferAgentKindKey,
  normalizeAgentKinds,
  type AgentKindKey,
} from "../../ui/AgentPresentation";
import type { AgentView } from "./api";

export interface AgentCardView {
  agent: AgentView;
  agents: AgentView[];
  kinds: AgentKindKey[];
  sharedDirectory: boolean;
}

function directoryKey(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+/g, "/").toLowerCase();
}

/**
 * Agent 页卡片视图的合并规则（唯一事实源）：
 * - 按品牌分组；同品牌发现到同一目录（文件系统身份一致）的客户端合并成
 *   一张卡并合并类型徽标；
 * - 验收反馈（2026-09-25）：仅发现相关目录（无任何已发现目录）的客户端
 *   不单独出卡——同品牌已有目录卡时并入并合并类型徽标；整品牌都无目录时
 *   全体客户端合成一张卡，避免同一品牌出现多张「仅发现相关目录」。
 * 概览「已发现」计数复用本函数，保证两处卡片数量口径一致。
 */
export function buildAgentCardViews(agents: AgentView[]): Map<string, AgentCardView[]> {
  const grouped = new Map<string, AgentCardView[]>();
  const pathlessAgents: AgentView[] = [];
  for (const agent of agents) {
    const brand = normalizeBrandKey(agent.brand);
    const paths = [...new Set(agent.discoveredPaths.map(directoryKey).filter(Boolean))];
    const existingGroup = grouped.get(brand) ?? [];
    // 权威 kind 在 AgentView.kinds（来自 discovery 快照的 ClientKind）；
    // 字符串推断只作为旧数据缺 kinds 时的兜底。
    const kind = agent.kinds?.[0] ?? inferAgentKindKey(agent.client, agent.instance);
    const existing = paths.length > 0
      ? existingGroup.find((card) => {
          const cardPaths = new Set(card.agent.discoveredPaths.map(directoryKey).filter(Boolean));
          return paths.some((path) => cardPaths.has(path));
        })
      : undefined;
    if (existing) {
      existing.agents.push(agent);
      existing.kinds = normalizeAgentKinds([...existing.kinds, kind]);
      existing.agent = {
        ...existing.agent,
        discoveredPaths: [...new Set([...existing.agent.discoveredPaths, ...agent.discoveredPaths])],
        managedDeploymentCount: Math.max(existing.agent.managedDeploymentCount, agent.managedDeploymentCount),
        managedDeploymentRelationCount: Math.max(
          existing.agent.managedDeploymentRelationCount,
          agent.managedDeploymentRelationCount,
        ),
      };
      existing.sharedDirectory ||= kind === "shared_directory";
      continue;
    }
    if (paths.length === 0) {
      pathlessAgents.push(agent);
      continue;
    }
    existingGroup.push({
      agent,
      agents: [agent],
      kinds: normalizeAgentKinds([kind]),
      sharedDirectory: kind === "shared_directory",
    });
    grouped.set(brand, existingGroup);
  }
  for (const agent of pathlessAgents) {
    const brand = normalizeBrandKey(agent.brand);
    const existingGroup = grouped.get(brand);
    const kind = agent.kinds?.[0] ?? inferAgentKindKey(agent.client, agent.instance);
    const existing = existingGroup?.[0];
    if (existing) {
      existing.agents.push(agent);
      // 已有具体类型徽标时不再叠加 unknown 兜底徽标，避免合并卡出现「Agent」噪音。
      if (!(kind === "unknown" && existing.kinds.length > 0)) {
        existing.kinds = normalizeAgentKinds([...existing.kinds, kind]);
      }
      existing.sharedDirectory ||= kind === "shared_directory";
      continue;
    }
    grouped.set(brand, [{
      agent,
      agents: [agent],
      kinds: normalizeAgentKinds([kind]),
      sharedDirectory: kind === "shared_directory",
    }]);
  }
  return grouped;
}

/**
 * 概览「已发现」计数（验收反馈 2026-09-25）：与 Agent 页渲染出来的卡片
 * 数量完全一致——合并的按 1 张计，被并入品牌卡不再单独展示的不计；
 * 自定义 Agent 不是「发现」口径，不计入。
 */
export function countDiscoveredAgentCards(agents: AgentView[]): number {
  const discovered = agents.filter((agent) => agent.status !== "custom");
  let total = 0;
  for (const cards of buildAgentCardViews(discovered).values()) {
    total += cards.length;
  }
  return total;
}
