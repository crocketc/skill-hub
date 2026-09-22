import { useTranslation } from "react-i18next";
import type { ClientKind } from "../api/bindings";
import { agentKindLabel } from "./AgentPresentation";
import "./AgentKindBadge.css";

export interface AgentKindBadgeProps {
  /** 组内去重后的客户端类型集合；按给定顺序以 "/" 连接展示。 */
  kinds: ClientKind[];
}

/**
 * P1-06：有适配器证据的 Agent 类型徽标（kind 来自 profile 声明，
 * 发现快照逐实例输出）。多个类型合并在一张卡片上以 "/" 连接，
 * 例如 "桌面端/终端"。
 */
export function AgentKindBadge({ kinds }: AgentKindBadgeProps): JSX.Element | null {
  const { t } = useTranslation();
  if (kinds.length === 0) return null;
  // 未知 kind（后端扩枚举）退回原始值，不显示 undefined。
  const label = [...new Set(kinds)]
    .map((kind) => agentKindLabel(kind, (key) => String(t(key as never))))
    .join("/");
  return (
    <span
      aria-label={label}
      className="sh-agent-kind-badge"
      title={t("agents.kind.evidenceTitle", { kind: label })}
    >
      {label}
    </span>
  );
}
