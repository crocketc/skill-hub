import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relationshipsKeys } from "../api";
import type { RelationGovernanceFacade } from "./api";
import {
  governanceContextCheckStorageKey,
  useRelationshipContextCheck,
} from "./useRelationshipContextCheck";

function makeFacade(overrides: Partial<RelationGovernanceFacade> = {}): RelationGovernanceFacade {
  return {
    listGovernance: vi.fn().mockResolvedValue({ counts: undefined, rows: [], total: 0 }),
    revalidate: vi.fn().mockResolvedValue({ items: [], relationship_revision: "2" }),
    listHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    retainSourceCopy: vi.fn().mockResolvedValue(undefined),
    relinkSourceCopy: vi.fn().mockResolvedValue(undefined),
    getRelationshipRemovalImpact: vi.fn().mockResolvedValue(undefined),
    prepareGovernanceBatch: vi.fn().mockResolvedValue(undefined),
    commitGovernanceBatch: vi.fn().mockResolvedValue(undefined),
    rollbackGovernanceBatch: vi.fn().mockResolvedValue(undefined),
    prepareRelationUndeploy: vi.fn().mockResolvedValue(undefined),
    commitRelationUndeploy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as RelationGovernanceFacade;
}

interface HookProps {
  scope: string;
  relationIds: readonly string[];
  enabled: boolean;
}

function useTwoChecks(first: HookProps, second: HookProps, facade: RelationGovernanceFacade): void {
  const facadeRef = useMemo(() => facade, [facade]);
  useRelationshipContextCheck({ ...first, facade: facadeRef });
  useRelationshipContextCheck({ ...second, facade: facadeRef });
}

describe("useRelationshipContextCheck（任务 11.6）", () => {
  let client: QueryClient;

  beforeEach(() => {
    sessionStorage.clear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  function render(options: HookProps, facade: RelationGovernanceFacade) {
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const view = renderHook(
      (props: HookProps) => useRelationshipContextCheck({ ...props, facade }),
      { initialProps: options, wrapper: Wrapper },
    );
    return { view, invalidateSpy };
  }

  it("lets the persisted ledger paint first, then runs the light check once per scope per session", async () => {
    const facade = makeFacade();
    const { view, invalidateSpy } = render(
      { scope: "all", relationIds: [], enabled: false },
      facade,
    );

    // 首屏未就绪：不触发，也不写会话记忆。
    expect(facade.revalidate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(governanceContextCheckStorageKey("all"))).toBeNull();

    // 清单渲染完成后（enabled=true 且有可见行）：异步 Light check 一次。
    view.rerender({ scope: "all", relationIds: ["r1", "r2"], enabled: true });
    await waitFor(() => expect(facade.revalidate).toHaveBeenCalledTimes(1));
    expect(facade.revalidate).toHaveBeenCalledWith(["r1", "r2"], "light");
    expect(sessionStorage.getItem(governanceContextCheckStorageKey("all"))).toBe("1");
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: relationshipsKeys.root,
    }));

    // 行集合随筛选变化不重放；同会话重挂载同 scope 也不重放。
    view.rerender({ scope: "all", relationIds: ["r1"], enabled: true });
    view.unmount();
    const facadeCalls = facade.revalidate as ReturnType<typeof vi.fn>;
    const second = render({ scope: "all", relationIds: ["r1", "r2"], enabled: true }, facade);
    expect(facadeCalls.mock.calls).toHaveLength(1);
    second.view.unmount();
  });

  it("checks again for a different scope in the same session", async () => {
    const facade = makeFacade();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { rerender } = renderHook(
      (props: { first: HookProps; second: HookProps }) =>
        useTwoChecks(props.first, props.second, facade),
      {
        initialProps: {
          first: { scope: "source_copy", relationIds: ["s1"], enabled: true },
          second: { scope: "deployment", relationIds: ["d1"], enabled: true },
        },
        wrapper: Wrapper,
      },
    );

    await waitFor(() => expect(facade.revalidate).toHaveBeenCalledTimes(2));
    expect(facade.revalidate).toHaveBeenCalledWith(["s1"], "light");
    expect(facade.revalidate).toHaveBeenCalledWith(["d1"], "light");
    rerender({
      first: { scope: "source_copy", relationIds: ["s1"], enabled: true },
      second: { scope: "deployment", relationIds: ["d1"], enabled: true },
    });
    expect(facade.revalidate).toHaveBeenCalledTimes(2);
  });

  it("still invalidates the ledger when the automatic check fails", async () => {
    const facade = makeFacade({
      revalidate: vi.fn().mockRejectedValue(new Error("probe failed")),
    });
    const { invalidateSpy } = render(
      { scope: "all", relationIds: ["r1"], enabled: true },
      facade,
    );

    await waitFor(() => expect(facade.revalidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: relationshipsKeys.root,
    }));
  });
});
