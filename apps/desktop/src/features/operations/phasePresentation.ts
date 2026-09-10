import type { OperationPhase } from "./api";
import type { IconName } from "../../ui/Icon";

/**
 * T4-A 全站统一映射：操作阶段 → 语义色调 + 本地功能图标。
 * 图标仅作装饰（aria-hidden），阶段含义始终由文字徽标承载。
 */
export const PHASE_PRESENTATION: Record<OperationPhase, { icon: IconName; tone: "success" | "danger" | "warning" | "info" | "muted" }> = {
  planned: { icon: "info", tone: "muted" },
  prepared: { icon: "info", tone: "muted" },
  applying: { icon: "update", tone: "warning" },
  verifying: { icon: "info", tone: "warning" },
  committed: { icon: "success", tone: "success" },
  needs_recovery: { icon: "failure", tone: "danger" },
  rolled_back: { icon: "restore", tone: "muted" },
};
