import { useContext, useRef } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import type { AgentFacade } from "../agents/api";
import { nativeAgentFacade } from "../agents/nativeApi";
import type { ProjectFacade } from "../projects/api";
import { nativeProjectFacade } from "../projects/nativeApi";
import { agentBrandKey, inferAgentKindKey, type AgentKindKey } from "../../ui/AgentPresentation";
import { normalizeBrandKey } from "../../ui/BrandTag";
import { countDiscoveredAgentCards } from "../agents/agentCards";

/**
 * 概览图表类别 key（Agent 客户端 id / 项目 id）→ 可读名称的解析来源。
 * 项目是纯名称字符串；Agent 是「品牌 + 展示类型」呈现事实（验收反馈
 * 2026-09-25：图表与明细必须按规则显示品牌+类型，不允许裸奔 client_id）。
 */
export type OverviewDeploymentName = string | OverviewAgentName;

export interface OverviewAgentName {
  brand: string;
  kinds: AgentKindKey[];
}

/**
 * DEV-22-A：部署分布图表的可读名称来源。
 *
 * 后端按维度分组时只给出类别 key（Agent 客户端 id / 项目 id）与维度级
 * `label_code`，柱状图因此会把内部 i18n 键直接画出来。这里把 key 解析成
 * Agent/项目名：Agent 用统一 presenter 的品牌 key 与类型徽标事实，查不到
 * 就退回翻译后的维度名，绝不渲染原始键。
 *
 * 纯浏览查询：与概览其他只读查询同构，不经 runTrackedOperation。
 */
export function useOverviewDeploymentNames(
  agentFacade: AgentFacade = nativeAgentFacade,
  projectFacade: ProjectFacade = nativeProjectFacade,
): ReadonlyMap<string, OverviewDeploymentName> {
  const contextClient = useContext(QueryClientContext);
  const fallbackClientRef = useRef<QueryClient | null>(null);
  if (fallbackClientRef.current === null) {
    fallbackClientRef.current = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
  }
  const queryClient = contextClient ?? fallbackClientRef.current;
  const enabled = contextClient !== undefined;

  const agentsQuery = useQuery(
    {
      enabled,
      queryFn: () => agentFacade.list(),
      queryKey: ["overview", "deployment-names", "agents"],
      staleTime: 30_000,
    },
    queryClient,
  );
  const projectsQuery = useQuery(
    {
      enabled,
      queryFn: () => projectFacade.list(),
      queryKey: ["overview", "deployment-names", "projects"],
      staleTime: 30_000,
    },
    queryClient,
  );

  const names = new Map<string, OverviewDeploymentName>();
  for (const agent of agentsQuery.data ?? []) {
    // 自定义 Agent 的 key 是自身 id，没有品牌档案；名称由 api 层兜底。
    if (agent.status === "custom") {
      if (agent.id) names.set(agent.id, agent.instance || agent.id);
      continue;
    }
    // 后端按 client_id 分组；同一客户端的多个实例（含内置只读视图）共享该
    // key，类型徽标取并集。
    const kinds = agent.kinds ?? [inferAgentKindKey(agent.client, agent.instance)];
    const fact: OverviewAgentName = {
      brand: normalizeBrandKey(agent.brand || agentBrandKey(agent.id || agent.client)),
      kinds,
    };
    for (const key of [agent.client, agent.id]) {
      if (!key) continue;
      const existing = names.get(key);
      if (existing && typeof existing === "object") {
        for (const kind of fact.kinds) {
          if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
        }
        continue;
      }
      names.set(key, fact);
    }
  }
  for (const project of projectsQuery.data ?? []) {
    if (project.name) names.set(project.id, project.name);
  }
  return names;
}

/**
 * 验收反馈（2026-09-25）：概览「已发现」数量必须与 Agent 页卡片数量一致
 * （合并的按 1 张计，不展示的不计）。复用名称解析的同一 agents 查询缓存，
 * 数据未就绪时返回 undefined，由指标层回退到发现快照口径。
 */
export function useDiscoveredAgentCardCount(
  agentFacade: AgentFacade = nativeAgentFacade,
): number | undefined {
  const contextClient = useContext(QueryClientContext);
  const fallbackClientRef = useRef<QueryClient | null>(null);
  if (fallbackClientRef.current === null) {
    fallbackClientRef.current = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
  }
  const queryClient = contextClient ?? fallbackClientRef.current;
  const enabled = contextClient !== undefined;

  const agentsQuery = useQuery(
    {
      enabled,
      queryFn: () => agentFacade.list(),
      queryKey: ["overview", "deployment-names", "agents"],
      staleTime: 30_000,
    },
    queryClient,
  );
  return agentsQuery.data ? countDiscoveredAgentCards(agentsQuery.data) : undefined;
}
