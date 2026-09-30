import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentCardModel } from "../agents/agentCardModel";
import type { AgentFacade } from "../agents/api";
import { useDiscoveredAgentCardCount } from "./deploymentNames";

function facadeWith(models: AgentCardModel[]): AgentFacade {
  return {
    list: vi.fn().mockResolvedValue([]),
    listCardModels: vi.fn().mockResolvedValue(models),
  } as unknown as AgentFacade;
}

function cardModel(detailTarget: string): AgentCardModel {
  return {
    detailTarget,
  } as unknown as AgentCardModel;
}

describe("useDiscoveredAgentCardCount（2026-09-30 统一口径）", () => {
  it("counts the unified card models, the same source the agent page renders", async () => {
    // 概览「已发现」必须与 Agent 页卡片数一致：直接取统一卡片模型的
    // 长度，不再用旧清单自行合并出第二套口径。
    const facade = facadeWith([cardModel("openai"), cardModel("openai.builtin"), cardModel("zcode")]);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(() => useDiscoveredAgentCardCount(facade), { wrapper: Wrapper });

    await waitFor(() => expect(result.current).toBe(3));
    expect(facade.listCardModels).toHaveBeenCalled();
  });

  it("keeps custom agent cards in the caliber because the agent page renders them too", async () => {
    // 自定义 Agent 以统一卡进入列表页，概览口径随之包含，不再排除。
    const facade = facadeWith([cardModel("zcode"), cardModel("custom-acme")]);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(() => useDiscoveredAgentCardCount(facade), { wrapper: Wrapper });

    await waitFor(() => expect(result.current).toBe(2));
  });

  it("stays undefined until the card models resolve so the metric layer can degrade", async () => {
    const facade = {
      list: vi.fn().mockResolvedValue([]),
      listCardModels: vi.fn().mockReturnValue(new Promise(() => {})),
    } as unknown as AgentFacade;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(() => useDiscoveredAgentCardCount(facade), { wrapper: Wrapper });

    expect(result.current).toBeUndefined();
  });
});
