import { useTranslation } from "react-i18next";
import type { ClientKind } from "../api/bindings";
import "./AgentKindBadge.css";

export interface AgentKindBadgeProps {
  /** 组内去重后的客户端类型集合；按给定顺序以 "/" 连接展示。 */
  kinds: ClientKind[];
}

const KIND_KEYS: Record<ClientKind, string> = {
  cli: "agents.kind.cli",
  desktop: "agents.kind.desktop",
  ide_extension: "agents.kind.ideExtension",
  tui: "agents.kind.tui",
  headless: "agents.kind.headless",
  acp: "agents.kind.acp",
  web: "agents.kind.web",
  mobile: "agents.kind.mobile",
  bot: "agents.kind.bot",
};

/**
 * P1-06：有适配器证据的 Agent 类型徽标（kind 来自 profile 声明，
 * 发现快照逐实例输出）。多个类型合并在一张卡片上以 "/" 连接，
 * 例如 "桌面端/CLI"。
 */
export function AgentKindBadge({ kinds }: AgentKindBadgeProps): JSX.Element | null {
  const { t } = useTranslation();
  if (kinds.length === 0) return null;
  // 未知 kind（后端扩枚举）退回原始值，不显示 undefined。
  const label = kinds
    .map((kind) => (KIND_KEYS[kind] ? String(t(KIND_KEYS[kind] as never)) : kind))
    .join("/");
  return (
    <span className="sh-agent-kind-badge" title={t("agents.kind.evidenceTitle")}>
      {label}
    </span>
  );
}
