import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  executeCommand,
  queryApplication,
  type DiscoverySnapshot,
} from "../../api/bindings";
import { queryClient as appQueryClient } from "../../app/queryClient";
import { notifyDiscoveryFactsChanged } from "../../platform/discoveryEvents";
import { brandDisplayName, normalizeBrandKey } from "../../ui/BrandTag";
import type { NotifyFunction } from "./backgroundScan";

export interface AgentDiscoveryRefreshBridgeProps {
  /** 全局通知服务；由 AppShell 注入，保持本组件不依赖壳层内部。 */
  notify: NotifyFunction;
  /** 初始化完成后才启动后台刷新；初始化向导自己会做首次发现。 */
  enabled: boolean;
  /** 测试接缝：读取当前（上次扫描落库的）发现快照。 */
  readSnapshot?: () => Promise<DiscoverySnapshot>;
  /** 测试接缝：执行一次 Agent 发现并返回新快照。 */
  runDiscovery?: () => Promise<DiscoverySnapshot>;
}

function nativeReadSnapshot(): Promise<DiscoverySnapshot> {
  return queryApplication({ type: "get_discovery_snapshot", payload: null })
    .then((result) => {
      if (result.type !== "discovery_snapshot") {
        throw new Error("get_discovery_snapshot returned an unexpected native result.");
      }
      return result.payload;
    });
}

function nativeRunDiscovery(): Promise<DiscoverySnapshot> {
  return executeCommand({ type: "discover_agent_targets", payload: null })
    .then((result) => {
      if (result.type !== "discovery_snapshot") {
        throw new Error("discover_agent_targets returned an unexpected native result.");
      }
      return result.payload;
    });
}

function instanceKey(instance: { profile_id: string; client_id: string }): string {
  return `${instance.profile_id}:${instance.client_id}`;
}

/**
 * 启动期后台 Agent 重扫桥（2026-09-26 验收反馈）：应用启动后异步执行一次
 * discover_agent_targets，发现快照里出现新的品牌/客户端时发一条通知并
 * 广播刷新。设计约束：
 * - 异步后台执行，绝不阻塞首屏；
 * - 只在“确有新品牌/类型”时通知，日常启动保持安静；
 * - 刷新失败同样安静——Agent 页随时可手动重扫，启动期告警只会变成固定噪音；
 * - 每次应用会话只跑一次（语言切换等无关变化不重跑）。
 */
export function AgentDiscoveryRefreshBridge({
  notify,
  enabled,
  readSnapshot,
  runDiscovery,
}: AgentDiscoveryRefreshBridgeProps) {
  const { t } = useTranslation();
  const startedRef = useRef(false);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const read = readSnapshot ?? nativeReadSnapshot;
        const discover = runDiscovery ?? nativeRunDiscovery;
        const before = await read();
        const after = await discover();
        if (cancelled) return;

        const known = new Set(before.instances.map(instanceKey));
        const fresh = after.instances.filter((instance) => !known.has(instanceKey(instance)));
        if (fresh.length === 0) return;

        const brands = [...new Set(fresh.map((instance) => brandDisplayName(normalizeBrandKey(instance.profile_id))))].join("、");
        notify({
          tone: "info",
          title: t("bootstrap.agentRefresh.newTitle"),
          detail: t("bootstrap.agentRefresh.newDetail", { count: fresh.length, brands }),
          action: { label: t("bootstrap.agentRefresh.action"), to: "/agents" },
        });
        // Agent 页是本地 state：广播让它重读；概览的发现数走 react-query：
        // 直接用应用级 queryClient 失效（本桥不依赖 Provider 挂载位置）。
        notifyDiscoveryFactsChanged();
        void appQueryClient.invalidateQueries({ queryKey: ["overview"] });
      } catch {
        // 静默：见组件注释。
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, notify, readSnapshot, runDiscovery, t]);

  return null;
}
