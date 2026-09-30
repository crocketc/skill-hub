import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { buildAgentCardViews } from "../agents/agentCards";
import { buildAgentDirectoryCardModels } from "../agents/agentCardModel";
import type { AgentDirectoryProjection } from "../../api/bindings";
import type { AgentDirectoryView, AgentView } from "../agents/api";
import { DeploymentCapabilityIcons } from "../agents/DeploymentCapabilityIcons";
import { Button } from "../../ui/Button";
import { AgentPresentation, agentKindLabel, isAgentKindKey, type AgentKindKey } from "../../ui/AgentPresentation";
import { AgentDirectoryRoleBadge } from "../../ui/AgentDirectoryRoleBadge";
import { brandDisplayName } from "../../ui/BrandTag";
import { CheckboxField } from "../../ui/CheckboxField";
import { displayPath } from "../../platform/displayPath";
import type { CompatibilityTarget } from "../bootstrap/api";

interface CompatibilityStepProps {
  confirmed: boolean;
  isDiscovering: boolean;
  selectedTargetIds: string[];
  targets: CompatibilityTarget[] | null;
  projection?: AgentDirectoryProjection | null;
  onConfirmChange: (confirmed: boolean) => void;
  onDiscover: () => void;
  onTargetSelectionChange: (targetId: string, selected: boolean) => void;
  onSelectAllAvailable: () => void;
}

interface CompatibilityCardGroup {
  brand: string;
  kinds: AgentKindKey[];
  path?: string;
  directory?: AgentDirectoryView;
  pendingCreation: boolean;
  role: AgentDirectoryView["role"];
  deploymentStatus: AgentDirectoryView["deploymentStatus"];
  supportsSharedDirectory: boolean;
  sharedDirectory: boolean;
  sharedAgentBrands: string[];
  sharedAgentBrandKinds: Record<string, string[]>;
  targets: CompatibilityTarget[];
}

function cardGroupsFor(targets: CompatibilityTarget[], projection?: AgentDirectoryProjection | null): CompatibilityCardGroup[] {
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  if (projection) {
    return buildAgentDirectoryCardModels(projection)
      .filter((card) => card.directories[0]?.role !== "project")
      .filter((card) => card.directoryMembers && card.directoryMembers.length > 0)
      .map((card) => {
        const seen = new Set<string>();
        const representedTargets = (card.directoryMembers ?? []).flatMap((member) => {
          const target = targetsById.get(member.logical_target_id);
          if (!target || seen.has(target.id)) return [];
          seen.add(target.id);
          const availability = member.availability.available && target.availability === "available"
            ? "available" as const
            : member.availability.status === "missing" || card.directories[0]?.status === "pending_creation"
              ? "pending_creation" as const
              : "unavailable" as const;
          return [{ ...target, availability }];
        });
        return {
          brand: card.brand,
          kinds: card.kinds,
          path: card.directories[0]?.path ?? undefined,
          directory: card.directories[0],
          role: card.directories[0]?.role ?? "agent_user",
          deploymentStatus: card.deploymentStatus,
          supportsSharedDirectory: card.supportsSharedDirectory,
          pendingCreation: card.directories[0]?.status === "pending_creation",
          sharedDirectory: card.sharedDirectory,
          sharedAgentBrands: card.sharedAgentBrands,
          sharedAgentBrandKinds: card.sharedAgentBrandKinds,
          targets: representedTargets,
        };
      });
  }

  const views: AgentView[] = targets.map((target) => ({
    id: target.id,
    brand: target.profileId ?? target.label,
    client: target.label,
    discoveredPaths: target.path ? [target.path] : [],
    instance: target.label,
    managedDeploymentCount: 0,
    managedDeploymentRelationCount: 0,
    officialReference: null,
    relations: [],
    status: target.availability === "available" ? "accessible" : "inaccessible",
    kinds: target.kind && isAgentKindKey(target.kind) ? [target.kind] : undefined,
  }));

  // Use the Agent page's card builder so directory identity and merged kind
  // decisions remain the same across the discovery entry points.
  return [...buildAgentCardViews(views).entries()].flatMap(([brand, cards]) =>
    cards.map((card) => ({
      brand: card.agent.brand || brand,
      kinds: card.kinds,
      path: card.agent.discoveredPaths[0],
      directory: card.model.directories[0],
      role: card.model.directories[0]?.role ?? "agent_user",
      deploymentStatus: card.model.deploymentStatus,
      supportsSharedDirectory: card.model.supportsSharedDirectory,
      pendingCreation: card.agents.some((agent) => targetsById.get(agent.id)?.availability === "pending_creation"),
      sharedDirectory: card.sharedDirectory,
      sharedAgentBrands: card.model.sharedAgentBrands,
      sharedAgentBrandKinds: card.model.sharedAgentBrandKinds,
      targets: card.agents.flatMap((agent) => {
        const target = targetsById.get(agent.id);
        return target ? [target] : [];
      }),
    })),
  );
}

export function selectableCompatibilityTargetIds(
  targets: CompatibilityTarget[] | null,
  projection?: AgentDirectoryProjection | null,
): string[] {
  if (!targets) return [];
  return [...new Set(cardGroupsFor(targets, projection)
    .flatMap((group) => group.targets)
    .filter((target) => target.availability === "available")
    .map((target) => target.id))];
}

export function CompatibilityStep({
  confirmed,
  isDiscovering,
  selectedTargetIds,
  targets,
  projection,
  onConfirmChange,
  onDiscover,
  onTargetSelectionChange,
  onSelectAllAvailable,
}: CompatibilityStepProps) {
  const { t } = useTranslation();
  const cardGroups = useMemo(() => targets ? cardGroupsFor(targets, projection) : [], [targets, projection]);
  const availableCount = cardGroups.reduce((count, group) => count + group.targets.filter((target) => target.availability === "available").length, 0);

  return (
    <section aria-labelledby="compatibility-step-title" className="sh-onboarding__card sh-onboarding__compatibility">
      <div className="sh-onboarding__step-heading">
        <h1 id="compatibility-step-title">{t("onboarding.compatibilityTitle")}</h1>
        <p>{t("onboarding.compatibilityDescription")}</p>
      </div>
      <div className="sh-onboarding__confirm-row">
        <CheckboxField
          checked={confirmed}
          label={t("onboarding.compatibilityConfirmation")}
          onChange={(event) => onConfirmChange(event.target.checked)}
        />
        <div className="sh-onboarding__step-actions">
          <Button disabled={!confirmed} loading={isDiscovering} onClick={onDiscover}>
            {t("onboarding.discoverAgents")}
          </Button>
          {targets && targets.length > 0 ? (
            <span className="sh-onboarding__target-count">
              {t("onboarding.compatibilityPathCount", { count: cardGroups.length, available: availableCount })}
            </span>
          ) : null}
        </div>
      </div>
      {targets && targets.length === 0 ? <p>{t("onboarding.noCompatibleTargets")}</p> : null}
      {targets && targets.length > 0 ? (
        <fieldset className="sh-onboarding__targets">
          <legend>{t("onboarding.compatibilityTargets")}</legend>
          <div className="sh-onboarding__target-list-header">
            <p>{t("onboarding.compatibilityPathHelper")}</p>
            {availableCount > 0 ? (
              <Button onClick={onSelectAllAvailable} size="sm" variant="secondary">
                {t("onboarding.selectAllAvailable")}
              </Button>
            ) : null}
          </div>
          <div aria-label={t("onboarding.compatibilityTargets")} className="sh-onboarding__target-scroll">
            <div className="sh-onboarding__target-grid">
              {cardGroups.map((group) => (
                <TargetCard
                  group={group}
                  key={group.brand + ":" + (group.path ?? "pathless") + ":" + group.targets.map((target) => target.id).join(",")}
                  selectedTargetIds={selectedTargetIds}
                  onTargetSelectionChange={onTargetSelectionChange}
                />
              ))}
            </div>
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}

function TargetCard({
  group,
  selectedTargetIds,
  onTargetSelectionChange,
}: {
  group: CompatibilityCardGroup;
  selectedTargetIds: string[];
  onTargetSelectionChange: (targetId: string, selected: boolean) => void;
}) {
  const { t } = useTranslation();
  const selectableTargets = group.targets.filter((target) => target.availability !== "unavailable");
  const selectableIds = selectableTargets.map((target) => target.id);
  const checked = selectableIds.length > 0 && selectableIds.every((id) => selectedTargetIds.includes(id));
  const pendingCreation = group.pendingCreation || group.targets.some((target) => target.availability === "pending_creation");
  const unavailable = selectableIds.length === 0 && !pendingCreation;
  const kindLabels = group.kinds.map((kind) => agentKindLabel(kind, (key) => String(t(key as never))));
  const presentationLabel = group.sharedDirectory
    ? String(t("agents.kind.sharedDirectory"))
    : kindLabels.join("/") || String(t("agents.kind.unknown"));
  const ariaLabel = brandDisplayName(group.brand) + " · " + presentationLabel;
  const description = unavailable
    ? String(t("onboarding.unavailable"))
    : kindLabels.join(" · ");

  return (
    <div className="sh-onboarding__target-card" data-selected={checked ? "true" : "false"} data-unavailable={unavailable ? "true" : "false"}>
      <CheckboxField
        ariaLabel={ariaLabel}
        checked={checked}
        description={description || undefined}
        disabled={unavailable}
        label={(
          <span className="sh-onboarding__target-card-content">
            <span className="sh-onboarding__target-card-heading">
              <AgentPresentation
                agentId={group.brand}
                brand={group.brand}
                deploymentStatus={group.deploymentStatus}
                kinds={group.kinds}
                sharedDirectory={group.sharedDirectory}
                sharedAgentBrands={group.sharedAgentBrands}
                sharedAgentBrandKinds={group.sharedAgentBrandKinds}
              />
            </span>
            <span className="sh-onboarding__target-role">
              <AgentDirectoryRoleBadge role={group.role} />
            </span>
            <span className="sh-onboarding__target-path-label">
              {t("agents.pathLabel")}
              {group.supportsSharedDirectory && !group.sharedDirectory ? (
                <span className="sh-agent-card__shared-chip">{t("agents.sharedDirectoryChip")}</span>
              ) : null}
            </span>
            <code className="sh-onboarding__target-path">
              {pendingCreation
                ? t("agents.pathPending")
                : group.path
                  ? displayPath(group.path)
                  : t("onboarding.targetPathUnavailable")}
            </code>
            <DeploymentCapabilityIcons
              directory={group.directory}
              note={group.role === "builtin"
                ? String(t("agents.builtinHint"))
                : group.deploymentStatus === "deployed"
                  ? String(t("agents.cardDeploymentStatus.deployed"))
                  : group.deploymentStatus === "partially_deployed"
                    ? String(t("agents.cardDeploymentStatus.partiallyDeployed"))
                    : undefined}
              t={(key) => String(t(key as never))}
            />
          </span>
        )}
        onChange={(event) => {
          for (const id of selectableIds) onTargetSelectionChange(id, event.target.checked);
        }}
      />
    </div>
  );
}
