import { useTranslation } from "react-i18next";
import type { ClientKind } from "../api/bindings";
import { brandDisplayName, BrandTag, BRAND_DISPLAY_NAMES } from "./BrandTag";
import "./AgentPresentation.css";

export type AgentKindKey = ClientKind | "unknown";

const KIND_KEYS: Record<AgentKindKey, string> = {
  cli: "agents.kind.cli",
  desktop: "agents.kind.desktop",
  ide_extension: "agents.kind.ideExtension",
  tui: "agents.kind.tui",
  headless: "agents.kind.headless",
  acp: "agents.kind.acp",
  web: "agents.kind.web",
  mobile: "agents.kind.mobile",
  bot: "agents.kind.bot",
  shared_directory: "agents.kind.sharedDirectory",
  unknown: "agents.kind.unknown",
};

const KIND_ORDER: AgentKindKey[] = [
  "desktop",
  "cli",
  "tui",
  "ide_extension",
  "web",
  "mobile",
  "bot",
  "headless",
  "acp",
  "shared_directory",
  "unknown",
];

const DEFAULT_KIND_LABELS: Record<AgentKindKey, string> = {
  cli: "Terminal",
  desktop: "Desktop",
  ide_extension: "IDE extension",
  tui: "Terminal",
  headless: "Background service",
  acp: "Protocol integration",
  web: "Web client",
  mobile: "Mobile",
  bot: "Robot",
  shared_directory: "Shared directory",
  unknown: "Agent",
};

export function agentKindLabelKey(kind: AgentKindKey): string {
  return KIND_KEYS[kind] ?? kind;
}

export function isAgentKindKey(value: string): value is AgentKindKey {
  return value in KIND_KEYS;
}

export function agentKindLabel(kind: AgentKindKey, translate: (key: string) => string): string {
  const key = agentKindLabelKey(kind);
  const translated = translate(key);
  return translated === key ? (DEFAULT_KIND_LABELS[kind] ?? kind) : translated;
}

export function agentBrandKey(id: string): string {
  const lowered = id.trim().toLowerCase();
  if (!lowered) return "unknown";
  if (BRAND_DISPLAY_NAMES[lowered]) return lowered;
  const profile = lowered.split(".")[0] ?? lowered;
  if (BRAND_DISPLAY_NAMES[profile]) return profile;
  const family = profile.split("-")[0] ?? profile;
  return BRAND_DISPLAY_NAMES[family] ? family : profile;
}

export function readableAgentIdName(id: string): string {
  const brand = agentBrandKey(id);
  return brand === "unknown" ? "Agent" : brandDisplayName(brand);
}

export function inferAgentKindKey(agentId = "", instance = ""): AgentKindKey {
  const value = `${agentId} ${instance}`.trim().toLowerCase();
  if (!value) return "unknown";
  if (value.includes("shared") || value.includes("agent-skills")) return "shared_directory";
  if (value.includes("ide") || value.includes("extension") || value.includes("plugin")) {
    return "ide_extension";
  }
  if (value.includes("desktop") || value.includes("workbuddy") || value.includes("editor")) {
    return "desktop";
  }
  if (value.includes("headless") || value.includes("background")) return "headless";
  if (value.includes("acp")) return "acp";
  if (value.includes("mobile")) return "mobile";
  if (value.includes("web")) return "web";
  if (value.includes("bot")) return "bot";
  if (value.includes("tui")) return "tui";
  if (value.includes("cli") || value.includes("terminal") || value.includes(".code") || value.includes("-code")) {
    return "cli";
  }
  return "unknown";
}

export function normalizeAgentKinds(
  kinds: readonly AgentKindKey[] | undefined,
  agentId = "",
  instance = "",
): AgentKindKey[] {
  const source: readonly AgentKindKey[] = kinds && kinds.length > 0
    ? kinds
    : [inferAgentKindKey(agentId, instance)];
  return [...new Set(source)].sort(
    (left, right) => KIND_ORDER.indexOf(left) - KIND_ORDER.indexOf(right),
  );
}

export interface AgentPresentationProps {
  agentId?: string;
  brand?: string;
  brandClassName?: string;
  className?: string;
  instance?: string;
  instanceNames?: string[];
  kinds?: readonly AgentKindKey[];
  sharedDirectory?: boolean;
}

export function AgentPresentation({
  agentId = "",
  brand,
  brandClassName,
  className,
  instance,
  instanceNames,
  kinds,
  sharedDirectory = false,
}: AgentPresentationProps): JSX.Element {
  const { t } = useTranslation();
  const resolvedKinds = normalizeAgentKinds(kinds, agentId, instance);
  const isShared = sharedDirectory || resolvedKinds.includes("shared_directory");
  const visibleKinds = isShared ? ["shared_directory" as const] : resolvedKinds;
  const resolvedBrand = brand?.trim() || agentBrandKey(agentId);
  const labels = visibleKinds.map((kind) => agentKindLabel(kind, (key) => String(t(key as never))));
  const brandLabel = isShared ? null : brandDisplayName(resolvedBrand);
  const accessibleName = [brandLabel, ...labels].filter(Boolean).join(" · ");
  const names = (instanceNames ?? (instance ? [instance] : [])).filter(Boolean);

  return (
    <span
      aria-label={accessibleName}
      className={["sh-agent-presentation", className].filter(Boolean).join(" ")}
      data-agent-kind={visibleKinds.join(",")}
    >
      {isShared ? null : <BrandTag brand={resolvedBrand} className={brandClassName} />}
      <span className="sh-agent-presentation__kind" title={accessibleName}>
        {labels.join("/")}
      </span>
      {names.length > 0 ? (
        <span className="sh-agent-presentation__names" title={names.join(" / ")}>
          {names.join(" / ")}
        </span>
      ) : null}
    </span>
  );
}

export function AgentIdentity({ agentId, ...props }: AgentPresentationProps & { agentId: string }) {
  return <AgentPresentation agentId={agentId} {...props} />;
}
