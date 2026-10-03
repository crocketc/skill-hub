import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ClientKind } from "../api/bindings";
import { brandDisplayName, BrandTag, BRAND_DISPLAY_NAMES } from "./BrandTag";
import "./AgentPresentation.css";

export type AgentKindKey = ClientKind | "unknown";
export type AgentPresentationDensity = "full" | "compact";

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

// A few supported clients have names that do not carry their user-facing kind
// in the identifier (for example `pi.coding-agent`). Keep those facts in the
// one shared presenter until every legacy identity DTO carries kind data.
const KNOWN_CLIENT_KINDS: Readonly<Record<string, AgentKindKey>> = {
  "pi.coding-agent": "cli",
  "hermes.agent": "cli",
  "openclaw.agent": "headless",
  "google.antigravity.app": "desktop",
  "google.antigravity.sdk": "headless",
  "cline.sdk": "headless",
  "github-copilot.cloud": "headless",
};

export function inferAgentKindKey(agentId = "", instance = ""): AgentKindKey {
  const value = `${agentId} ${instance}`.trim().toLowerCase();
  if (!value) return "unknown";
  const knownKind = KNOWN_CLIENT_KINDS[agentId.trim().toLowerCase()];
  if (knownKind) return knownKind;
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
  kinds?: readonly AgentKindKey[];
  sharedDirectory?: boolean;
  /** Brands that recognise one physical shared directory. */
  sharedAgentBrands?: readonly string[];
  /** Raw ClientKind values used in each shared brand logo tooltip. */
  sharedAgentBrandKinds?: Record<string, readonly string[]>;
  /** Use a popover for the overflow badge when the presenter is outside another interactive control. */
  sharedBrandOverflowInteractive?: boolean;
  /** Optional detail route for the represented Agent or shared directory. */
  detailTo?: string;
  deploymentStatus?: "deployed" | "partially_deployed" | "not_deployed" | "unknown";
  density?: AgentPresentationDensity;
}

export function AgentPresentation({
  agentId = "",
  brand,
  brandClassName,
  className,
  instance,
  kinds,
  sharedDirectory = false,
  sharedAgentBrands = [],
  sharedAgentBrandKinds = {},
  sharedBrandOverflowInteractive = true,
  detailTo,
  deploymentStatus = "unknown",
  density = "full",
}: AgentPresentationProps): JSX.Element {
  const { t } = useTranslation();
  const [showAllSharedBrands, setShowAllSharedBrands] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number; maxHeight: number }>();
  const sharedBrandsRef = useRef<HTMLSpanElement | null>(null);
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();
  const resolvedKinds = normalizeAgentKinds(kinds, agentId, instance);
  const isShared = sharedDirectory || resolvedKinds.includes("shared_directory");
  const visibleKinds = isShared ? ["shared_directory" as const] : resolvedKinds;
  const resolvedBrand = brand?.trim() || agentBrandKey(agentId);
  const sharedTitle = String(t("agents.sharedDirectoryTitle"));
  const labels = visibleKinds.map((kind) => agentKindLabel(kind, (key) => String(t(key as never))));
  const accessibleName = isShared
    ? [sharedTitle, ...sharedAgentBrands.map((candidate) => {
      const kindsForBrand = sharedAgentBrandKinds[candidate] ?? [];
      const kindLabels = kindsForBrand
        .filter(isAgentKindKey)
        .map((kind) => agentKindLabel(kind, (key) => String(t(key as never))));
      return [brandDisplayName(candidate), ...kindLabels].join(" · ");
    })].filter(Boolean).join("；")
    : [brandDisplayName(resolvedBrand), ...labels].filter(Boolean).join(" · ");
  const uniqueSharedBrands = [...new Set(sharedAgentBrands)];
  const visibleSharedBrands = uniqueSharedBrands.slice(0, 4);
  const hiddenSharedBrands = uniqueSharedBrands.slice(4);
  const hiddenSharedBrandLabels = hiddenSharedBrands.map((candidate) => {
    const kindsForBrand = sharedAgentBrandKinds[candidate] ?? [];
    const kindLabels = kindsForBrand
      .filter(isAgentKindKey)
      .map((kind) => agentKindLabel(kind, (key) => String(t(key as never))));
    return [brandDisplayName(candidate), ...kindLabels].join(" · ");
  });
  const updatePopoverPosition = useCallback(() => {
    if (!showAllSharedBrands) return;
    const anchor = overflowButtonRef.current;
    const popover = sharedBrandsRef.current?.querySelector<HTMLElement>(".sh-agent-presentation__shared-brands-popover");
    if (!anchor || !popover) return;

    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportMargin = 12;
    const anchorGap = 8;
    const availableBelow = Math.max(0, window.innerHeight - anchorRect.bottom - anchorGap - viewportMargin);
    const availableAbove = Math.max(0, anchorRect.top - anchorGap - viewportMargin);
    const placeAbove = popoverRect.height > availableBelow && availableAbove > availableBelow;
    const maxHeight = Math.max(96, Math.min(window.innerHeight - viewportMargin * 2, placeAbove ? availableAbove : availableBelow));
    const height = Math.min(popoverRect.height, maxHeight);
    const left = Math.max(viewportMargin, Math.min(anchorRect.right - popoverRect.width, window.innerWidth - viewportMargin - popoverRect.width));
    const top = placeAbove
      ? Math.max(viewportMargin, anchorRect.top - anchorGap - height)
      : Math.min(window.innerHeight - viewportMargin - height, anchorRect.bottom + anchorGap);
    setPopoverPosition({ left, top, maxHeight });
  }, [showAllSharedBrands, uniqueSharedBrands.length]);
  useLayoutEffect(() => {
    updatePopoverPosition();
  }, [updatePopoverPosition]);
  useEffect(() => {
    if (!showAllSharedBrands) return undefined;
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [showAllSharedBrands, updatePopoverPosition]);
  useEffect(() => {
    if (!showAllSharedBrands) return undefined;

    const closeAndRestoreFocus = () => {
      setShowAllSharedBrands(false);
      overflowButtonRef.current?.focus();
    };
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && !sharedBrandsRef.current?.contains(target)) {
        closeAndRestoreFocus();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };

    document.addEventListener("click", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showAllSharedBrands]);

  const sharedIdentity = (
    <>
      <span aria-hidden="true" className="sh-agent-presentation__vercel-logo" />
      {density === "full" ? <span className="sh-agent-presentation__shared-title">{sharedTitle}</span> : null}
    </>
  );
  const agentIdentity = (
    <>
      <BrandTag brand={resolvedBrand} className={brandClassName} iconOnly={density === "compact"} />
      {!isShared && density === "full" ? (
        <>
          {deploymentStatus === "deployed" || deploymentStatus === "partially_deployed" ? (
            <span
              aria-label={deploymentStatus === "deployed" ? String(t("agents.cardDeploymentStatus.deployed")) : String(t("agents.cardDeploymentStatus.partiallyDeployed"))}
              className={`sh-agent-presentation__deployment-status${deploymentStatus === "partially_deployed" ? " is-partial" : ""}`}
              title={String(t(deploymentStatus === "deployed" ? "agents.cardDeploymentStatus.deployed" : "agents.cardDeploymentStatus.partiallyDeployed"))}
            >{deploymentStatus === "deployed" ? "✓" : "◌"}</span>
          ) : null}
          <span className="sh-agent-presentation__kind" title={accessibleName}>{labels.join("/")}</span>
        </>
      ) : null}
    </>
  );

  return (
    <span
      aria-label={accessibleName}
      className={["sh-agent-presentation", `sh-agent-presentation--${density}`, className].filter(Boolean).join(" ")}
      data-agent-kind={visibleKinds.join(",")}
      title={accessibleName}
    >
      {detailTo ? (
        <Link aria-label={accessibleName} className="sh-agent-presentation__identity-link" to={detailTo}>
          {isShared ? sharedIdentity : agentIdentity}
        </Link>
      ) : isShared ? sharedIdentity : agentIdentity}
      {isShared ? (
        <span className="sh-agent-presentation__shared-brands" ref={sharedBrandsRef}>
          {visibleSharedBrands.map((candidate) => {
            const kindLabels = (sharedAgentBrandKinds[candidate] ?? [])
              .filter(isAgentKindKey)
              .map((kind) => agentKindLabel(kind, (key) => String(t(key as never))));
            const label = [brandDisplayName(candidate), ...kindLabels].join(" · ");
            return (
              <span aria-label={label} className="sh-agent-presentation__shared-brand-mark" key={candidate} tabIndex={0} title={label}>
                <BrandTag brand={candidate} iconOnly />
              </span>
            );
          })}
          {hiddenSharedBrands.length > 0 ? sharedBrandOverflowInteractive ? (
            <>
              <button
                aria-controls={popoverId}
                aria-expanded={showAllSharedBrands}
                aria-label={String(t("agents.sharedBrandOverflowButton", { count: uniqueSharedBrands.length }))}
                className="sh-agent-presentation__shared-brand-overflow"
                onClick={() => setShowAllSharedBrands((visible) => !visible)}
                ref={overflowButtonRef}
                title={hiddenSharedBrandLabels.join(" / ")}
                type="button"
              >+{hiddenSharedBrands.length}</button>
              {showAllSharedBrands ? (
                <div
                  aria-label={String(t("agents.sharedBrandsPopoverTitle"))}
                  className="sh-agent-presentation__shared-brands-popover"
                  id={popoverId}
                  role="dialog"
                  style={popoverPosition
                    ? { left: `${popoverPosition.left}px`, maxHeight: `${popoverPosition.maxHeight}px`, top: `${popoverPosition.top}px` }
                    : { visibility: "hidden" }}
                >
                  <h2 className="sh-agent-presentation__shared-brands-heading">{t("agents.sharedBrandsPopoverTitle")}</h2>
                  <ul className="sh-agent-presentation__shared-brands-list">
                    {uniqueSharedBrands.map((candidate) => {
                      const kindLabels = (sharedAgentBrandKinds[candidate] ?? [])
                        .filter(isAgentKindKey)
                        .map((kind) => agentKindLabel(kind, (key) => String(t(key as never))));
                      const label = [brandDisplayName(candidate), ...kindLabels].join(" · ");
                      return (
                        <li aria-label={label} className="sh-agent-presentation__shared-brand-row" key={candidate} tabIndex={0} title={label}>
                          <BrandTag brand={candidate} iconOnly title={label} />
                          <span className="sh-agent-presentation__shared-brand-name">{brandDisplayName(candidate)}</span>
                          {kindLabels.length > 0 ? (
                            <span className="sh-agent-presentation__shared-brand-kinds">
                              {kindLabels.map((kindLabel) => <span className="sh-agent-presentation__kind" key={kindLabel}>{kindLabel}</span>)}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <span
              aria-label={hiddenSharedBrandLabels.join(" / ")}
              className="sh-agent-presentation__shared-brand-overflow is-static"
              title={hiddenSharedBrandLabels.join(" / ")}
            >+{hiddenSharedBrands.length}</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export function AgentIdentity({ agentId, ...props }: AgentPresentationProps & { agentId: string }) {
  return <AgentPresentation agentId={agentId} {...props} />;
}
