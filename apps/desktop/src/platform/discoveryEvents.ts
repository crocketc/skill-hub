/**
 * 发现事实变更的应用内广播（2026-09-26）：启动期后台 Agent 重扫完成后，
 * 关心的视图各自刷新——Agent 页是本地 state 拉取（无 react-query key），
 * 概览的发现数走 react-query（由桥按 key 失效）。模式与
 * platform/deploymentEvents.ts 一致：提交方广播一次，消费方自行决定
 * 怎么刷新。
 */
const DISCOVERY_FACTS_CHANGED = "skillhub:discovery-facts-changed";

export function notifyDiscoveryFactsChanged(): void {
  window.dispatchEvent(new CustomEvent(DISCOVERY_FACTS_CHANGED));
}

/** 订阅发现事实变更；返回取消订阅函数（供 useEffect 清理）。 */
export function onDiscoveryFactsChanged(listener: () => void): () => void {
  window.addEventListener(DISCOVERY_FACTS_CHANGED, listener);
  return () => {
    window.removeEventListener(DISCOVERY_FACTS_CHANGED, listener);
  };
}
