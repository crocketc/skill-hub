import { useContext, useRef } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import type { AgentFacade } from "../agents/api";
import { nativeAgentFacade } from "../agents/nativeApi";
import type { ProjectFacade } from "../projects/api";
import { nativeProjectFacade } from "../projects/nativeApi";

/**
 * DEV-22-A：部署分布图表的可读名称来源。
 *
 * 后端按维度分组时只给出类别 key（Agent 客户端 id / 项目 id）与维度级
 * `label_code`，柱状图因此会把内部 i18n 键直接画出来。这里把 key 解析成
 * Agent/项目名：查不到就退回翻译后的维度名，绝不渲染原始键。
 *
 * 纯浏览查询：与概览其他只读查询同构，不经 runTrackedOperation。
 */
export function useOverviewDeploymentNames(
  agentFacade: AgentFacade = nativeAgentFacade,
  projectFacade: ProjectFacade = nativeProjectFacade,
): ReadonlyMap<string, string> {
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

  const names = new Map<string, string>();
  for (const agent of agentsQuery.data ?? []) {
    // 后端按 client_id 分组；同一客户端的多个实例共享该 key。
    if (agent.client) names.set(agent.client, agent.instance || agent.client);
    if (agent.id) names.set(agent.id, agent.instance || agent.client || agent.id);
  }
  for (const project of projectsQuery.data ?? []) {
    if (project.name) names.set(project.id, project.name);
  }
  return names;
}
