/**
 * DEV-22：部署事实变更的应用内广播。
 *
 * 部署提交成功后，各视图的计数数据源并不统一：技能库列表与详情页走
 * react-query（可按 key 失效），概览读的是启动期快照（BootstrapGate 的
 * useState，无 query key），Agent 页是本地 state 拉取。此前提交链路只
 * 失效了部分 key，概览与 Agent 页完全收不到通知，各处计数与关系页不
 * 一致。本模块补上缺失的那条通知链：提交成功广播一次，关心的视图各自
 * 刷新（快照经 outlet 的 refreshSnapshot，Agent 页经本地 revision）。
 */
const DEPLOYMENT_FACTS_CHANGED = "skillhub:deployment-facts-changed";

export function notifyDeploymentFactsChanged(): void {
  window.dispatchEvent(new CustomEvent(DEPLOYMENT_FACTS_CHANGED));
}

/** 订阅部署事实变更；返回取消订阅函数（供 useEffect 清理）。 */
export function onDeploymentFactsChanged(listener: () => void): () => void {
  window.addEventListener(DEPLOYMENT_FACTS_CHANGED, listener);
  return () => {
    window.removeEventListener(DEPLOYMENT_FACTS_CHANGED, listener);
  };
}
