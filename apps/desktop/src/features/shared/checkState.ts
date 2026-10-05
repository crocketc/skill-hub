import type { CheckState as NativeCheckState } from "../../api/bindings";
import type { CheckState } from "../skills/api";

/**
 * 检查状态语义统一（2026-10-05 定稿）：native 读模型报 4 态
 * （not_checked/running/passed/failed），界面语义为 5 态
 * （passed/warning/failed/not_checked(未运行)/unavailable）。
 * 列表（skills）与详情（skill-detail）共用这一条派生规则，
 * 不各写一份；字段命名各自保留（列表侧 not_run 即 not_checked 语义）。
 * 预警状态是独立字段（security_alerts），不进入本枚举。
 */
export function checkStateOf(state: NativeCheckState): CheckState {
  if (state === "not_checked") return "not_run";
  if (state === "running") return "warning";
  return state;
}

/** 检查状态徽标的共享 tone：通过绿、警告黄、失败红、其余（未运行/不可用）中性蓝。 */
export function checkStateTone(state: CheckState): "success" | "warning" | "danger" | "info" {
  if (state === "passed") return "success";
  if (state === "warning") return "warning";
  if (state === "failed") return "danger";
  return "info";
}

/**
 * 检查状态的可读文案键（与技能库表格同一组词：通过/警告/失败/未运行/不可用），
 * 消费方以 t() 翻译；详情徽标与列表徽标不得各造一套状态词。
 */
export const CHECK_STATE_LABEL_KEYS = {
  failed: "skillLibrary.table.checkStates.failed",
  not_run: "skillLibrary.table.checkStates.notRun",
  passed: "skillLibrary.table.checkStates.passed",
  unavailable: "skillLibrary.table.checkStates.unavailable",
  warning: "skillLibrary.table.checkStates.warning",
} as const satisfies Record<CheckState, string>;
