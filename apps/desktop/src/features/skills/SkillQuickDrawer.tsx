import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { displayPath } from "../../platform/displayPath";
import { describeNativeError } from "../../api/nativeErrors";
import * as Dialog from "@radix-ui/react-dialog";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { useOptionalAppNotifications } from "../../ui/notifications";
import {
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { Drawer } from "../../ui/Drawer";
import { Icon } from "../../ui/Icon";
import { AgentPresentation } from "../../ui/AgentPresentation";
import { buildSkillRelationshipViews } from "../relationshipGovernance/relationshipGovernance";
import type { SkillLibraryReturnState } from "../skill-detail/detailContext";
import { skillDetailKeys } from "../skill-detail/api";
import type { SkillDetailFacade } from "../skill-detail/api";
import {
  type DrawerPreset,
  type CombinationResult,
  type SkillDrawerPreferences,
  type SkillLibraryFacade,
  type SkillMetadataPatch,
  type SkillQuickView,
  skillLibraryKeys,
} from "./api";
import { InvocationBadge } from "./InvocationBadge";
import { BatchTagDialog, type BatchTagAction } from "./BatchTagDialog";
import { AgentDeploymentIcons } from "./AgentDeploymentIcons";
import { SecurityResults } from "../security/SecurityResults";
import type { SecurityCheck, SecurityCheckKind, SecurityFinding, SecurityFacade } from "../security/api";
import {
  OPTIONAL_DRAWER_MODULES,
  clampDrawerWidth,
  drawerWidthForPreset,
  normalizeDrawerPreferences,
} from "./drawerModules";
import "./skillQuickDrawer.css";

export interface SkillQuickDrawerProps {
  detailSearch?: string;
  /** DEV-only opt-in review presentation. */
  drawerPrototype?: boolean;
  facade: SkillLibraryFacade;
  libraryReturn?: SkillLibraryReturnState;
  onDelete?: (skillId: string, skillName: string) => void;
  onOpenChange: (open: boolean) => void;
  onPreferencesChange: (preferences: SkillDrawerPreferences) => void;
  open: boolean;
  preferenceSaveFailed?: boolean;
  preferences: SkillDrawerPreferences;
  /** Refresh the bootstrap projection after metadata changes. */
  refreshSnapshot?: () => Promise<void>;
  securityFacade: SecurityFacade;
  relationshipFacade?: Pick<SkillDetailFacade, "getProvenance" | "getRelationshipOverview">;
  trialFacade?: Pick<SkillDetailFacade, "setTrial">;
  returnFocusRef: RefObject<HTMLElement | null>;
  skillId?: string;
}

type OptionalDrawerModule = (typeof OPTIONAL_DRAWER_MODULES)[number];

interface ModuleProps {
  libraryReturn?: SkillLibraryReturnState;
  relationshipFacade?: Pick<SkillDetailFacade, "getProvenance" | "getRelationshipOverview">;
  open?: boolean;
  view: SkillQuickView;
  versionsHref?: string;
  versionsState?: { libraryReturn: SkillLibraryReturnState };
}

type ModuleRendererProps = ModuleProps & { securityFacade: SecurityFacade };

interface ModuleCardProps {
  children: ReactNode;
  title: string;
}

const MODULE_LABEL_KEYS = {
  identity: "skillLibrary.drawer.modules.identity",
  primary_actions: "skillLibrary.drawer.modules.primaryActions",
  risk_summary: "skillLibrary.drawer.modules.riskSummary",
  full_details: "skillLibrary.drawer.modules.fullDetails",
  relations: "skillLibrary.drawer.modules.relations",
  versions: "skillLibrary.drawer.modules.versions",
  source_license: "skillLibrary.drawer.modules.sourceLicense",
  security_checks: "skillLibrary.drawer.modules.securityChecks",
  usage_evidence: "skillLibrary.drawer.modules.usageEvidence",
} as const;

const PRESET_LABEL_KEYS = {
  near_full: "skillLibrary.drawer.presets.nearFull",
  standard: "skillLibrary.drawer.presets.standard",
  wide: "skillLibrary.drawer.presets.wide",
} as const satisfies Record<DrawerPreset, string>;

const FIXED_DRAWER_MODULE_ORDER = [
  "security_checks",
  "relations",
  "usage_evidence",
  "source_license",
] as const satisfies readonly OptionalDrawerModule[];

const DRAWER_PRESET_CYCLE: readonly DrawerPreset[] = ["standard", "wide", "near_full"];

const LIFECYCLE_LABEL_KEYS = {
  active: "skillLibrary.filters.lifecycleOptions.active",
  deprecated: "skillLibrary.filters.lifecycleOptions.deprecated",
  trial: "skillLibrary.filters.lifecycleOptions.trial",
} as const satisfies Record<SkillQuickView["lifecycle"], string>;

function ModuleCard({ children, title }: ModuleCardProps) {
  return (
    <section className="sh-skill-drawer__module">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function EmptyValue() {
  const { t } = useTranslation();
  return <span className="sh-skill-drawer__empty">{t("skillLibrary.drawer.emptyValue")}</span>;
}

/** 界面规范§5批注2：基本信息标签最多显示两行，溢出交给独立 +N 入口。 */
const MAX_VISIBLE_TAGS = 4;

/** 有界浮层状态：锚定触发按钮、视口钳制定位、关闭时按需恢复焦点。 */
function useBoundedPopover() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusOnClose = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (contentRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      restoreFocusOnClose.current = false;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);
  const close = (restoreFocus = false) => {
    restoreFocusOnClose.current = restoreFocus;
    setOpen(false);
  };
  const onOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) restoreFocusOnClose.current = true;
    setOpen(nextOpen);
  };
  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    if (restoreFocusOnClose.current) triggerRef.current?.focus();
    restoreFocusOnClose.current = false;
  };
  return {
    close,
    contentRef,
    onCloseAutoFocus,
    onOpenChange,
    open,
    position,
    setPosition,
    setOpen,
    triggerRef,
  };
}

interface DrawerBoundedPopoverProps {
  ariaLabel: string;
  children: ReactNode;
  className: string;
  contentRef: MutableRefObject<HTMLDivElement | null>;
  id?: string;
  onCloseAutoFocus: (event: Event) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  position: { left: number; top: number };
  setPosition: (position: { left: number; top: number }) => void;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
}

/** 抽屉深层操作的有界浮层：固定定位、视口边缘钳制，不裁切也不撑开正文。 */
function DrawerBoundedPopover({
  ariaLabel,
  children,
  className,
  contentRef,
  id,
  onCloseAutoFocus,
  onOpenChange,
  open,
  position,
  setPosition,
  triggerRef,
}: DrawerBoundedPopoverProps) {
  const titleId = useId();
  const setContentElement = (element: HTMLDivElement | null) => {
    contentRef.current = element;
    const trigger = triggerRef.current;
    if (!element || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    const panel = element.getBoundingClientRect();
    setPosition({
      left: Math.max(12, Math.min(anchor.left, window.innerWidth - panel.width - 12)),
      top: Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - panel.height - 12)),
    });
  };
  return (
    <Dialog.Root modal={false} onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Content
          aria-describedby={undefined}
          aria-labelledby={titleId}
          className={className}
          id={id}
          onCloseAutoFocus={onCloseAutoFocus}
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          ref={setContentElement}
          style={{ left: position.left, top: position.top }}
          tabIndex={-1}
        >
          <Dialog.Title className="sh-visually-hidden" id={titleId}>
            {ariaLabel}
          </Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RelationsModule({ libraryReturn, open = false, relationshipFacade, view }: ModuleProps) {
  const { t } = useTranslation();
  const relationshipQuery = useQuery({
    enabled: open && Boolean(relationshipFacade),
    queryFn: () => {
      if (!relationshipFacade) throw new Error("Relationship facts are unavailable.");
      return relationshipFacade.getRelationshipOverview(view.id);
    },
    queryKey: skillDetailKeys.relationship(view.id),
    retry: false,
  });
  const provenanceQuery = useQuery({
    enabled: open && Boolean(relationshipFacade),
    queryFn: () => {
      if (!relationshipFacade) throw new Error("Import provenance is unavailable.");
      return relationshipFacade.getProvenance(view.id);
    },
    queryKey: skillDetailKeys.provenance(view.id),
    retry: false,
  });
  const hasAuthoritativeFacade = Boolean(relationshipFacade);
  const authoritativeLoaded = hasAuthoritativeFacade && relationshipQuery.isSuccess && Boolean(relationshipQuery.data);
  const relationshipViews = authoritativeLoaded && relationshipQuery.data
    ? buildSkillRelationshipViews(relationshipQuery.data)
    : undefined;
  const nodeById = authoritativeLoaded && relationshipQuery.data
    ? new Map(relationshipQuery.data.directory_nodes.map((node) => [node.node_id, node]))
    : new Map();
  const agentTargets = [] as NonNullable<typeof relationshipViews>["deployments"];
  const projectTargets = [] as NonNullable<typeof relationshipViews>["deployments"];
  const unresolvedTargets = [] as NonNullable<typeof relationshipViews>["deployments"];
  for (const relation of relationshipViews?.deployments ?? []) {
    if (!relation.active) continue;
    const directory = relation.directoryNodeId ? nodeById.get(relation.directoryNodeId) : undefined;
    if (directory?.role === "project") {
      projectTargets.push(relation);
    } else if (
      directory
      && (directory.role === "agent_native" || directory.role === "shared_directory")
      && relation.targetAgentClientId.trim()
    ) {
      agentTargets.push(relation);
    } else {
      unresolvedTargets.push(relation);
    }
  }
  const legacyAgentDeployments = view.agentDeployments ?? [];
  const legacyProjects = view.projectDeployments ?? [];
  const unresolvedCount = hasAuthoritativeFacade
    ? authoritativeLoaded ? unresolvedTargets.length : 0
    : (view.unresolvedDeploymentCount ?? 0);
  const hasUnresolvedTargets = unresolvedCount > 0;
  const governanceHref = `/relationships/governance?from=library&skillId=${encodeURIComponent(view.id)}`;
  const relationHref = (relationId: string) =>
    `${governanceHref}&relationId=${encodeURIComponent(relationId)}`;
  const returnState = libraryReturn ? { libraryReturn } : undefined;
  const agentCount = authoritativeLoaded ? agentTargets.length : view.agentDeploymentCount;
  const projectCount = authoritativeLoaded ? projectTargets.length : view.projectDeploymentCount;
  const agentRegionLabel = t("skillLibrary.table.agentDeploymentSummary", { count: agentCount });
  const projectRegionLabel = t("skillLibrary.table.projectDeploymentSummary", { count: projectCount });

  const relationList = (
    relations: NonNullable<typeof relationshipViews>["deployments"],
    kind: "agent" | "project",
  ) => (
    <ul className="sh-skill-drawer__destination-list">
      {relations.map((relation) => {
        const directory = relation.directoryNodeId ? nodeById.get(relation.directoryNodeId) : undefined;
        const path = displayPath(relation.path);
        return (
          <li key={relation.relationId}>
            <div className="sh-skill-drawer__destination-identity">
              {kind === "agent" ? (
                <AgentPresentation
                  agentId={relation.targetAgentClientId}
                  detailTo={`/agents/${encodeURIComponent(relation.targetAgentClientId)}`}
                  sharedDirectory={directory?.role === "shared_directory"}
                  density="compact"
                />
              ) : (
                <strong>{t("skillLibrary.drawer.values.projectDirectory")}</strong>
              )}
              <code title={path}>{path || <EmptyValue />}</code>
            </div>
            <Link
              aria-label={t(`skillLibrary.drawer.review${kind === "agent" ? "Agent" : "Project"}Relationship`)}
              className="sh-button sh-button--ghost sh-button--sm"
              state={returnState}
              to={relationHref(relation.relationId)}
            >
              {t(`skillLibrary.drawer.review${kind === "agent" ? "Agent" : "Project"}Relationship`)}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  const groupContent = (
    kind: "agent" | "project",
    regionLabel: string,
  ) => {
    if (hasAuthoritativeFacade && relationshipQuery.isPending) {
      return <span role="status">{t("skillLibrary.drawer.relationships.loading")}</span>;
    }
    if (hasAuthoritativeFacade && relationshipQuery.isError) {
      return <span>{t("skillLibrary.drawer.relationships.unavailableGroup")}</span>;
    }
    if (hasAuthoritativeFacade) {
      const targets = kind === "agent" ? agentTargets : projectTargets;
      return targets.length > 0
        ? <div aria-label={regionLabel} className="sh-skill-drawer__relation-scroll" role="region" tabIndex={0}>{relationList(targets, kind)}</div>
        : hasUnresolvedTargets
          ? <span>{t("skillLibrary.drawer.values.unresolvedDestinationGroup")}</span>
          : <span>{t(kind === "agent" ? "skillLibrary.drawer.values.noLinkedAgents" : "skillLibrary.drawer.values.noLinkedProjects")}</span>;
    }
    if (kind === "agent" && legacyAgentDeployments.length > 0) {
      return (
        <div aria-label={regionLabel} className="sh-skill-drawer__relation-scroll" role="region" tabIndex={0}>
          <AgentDeploymentIcons agents={legacyAgentDeployments} ariaLabel={regionLabel} />
        </div>
      );
    }
    if (kind === "project" && legacyProjects.length > 0) {
      return (
        <div aria-label={regionLabel} className="sh-skill-drawer__relation-scroll" role="region" tabIndex={0}>
          <ul className="sh-skill-drawer__project-list">
            {legacyProjects.map((project) => (
              <li key={project.id}>
                <strong title={project.name}>{project.name}</strong>
                <code title={displayPath(project.path)}>{displayPath(project.path)}</code>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    return hasUnresolvedTargets
      ? <span>{t("skillLibrary.drawer.values.unresolvedDestinationGroup")}</span>
      : <EmptyValue />;
  };

  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.relations)}>
      <div className="sh-skill-drawer__relations-grid">
        {(["agent", "project"] as const).map((kind) => {
          const count = kind === "agent" ? agentCount : projectCount;
          const regionLabel = kind === "agent" ? agentRegionLabel : projectRegionLabel;
          return (
            <div className="sh-skill-drawer__relation-group" key={kind}>
              <div className="sh-skill-drawer__relation-heading">
                <strong>{t(kind === "agent" ? "skillLibrary.drawer.values.agents" : "skillLibrary.drawer.values.projects")}</strong>
                {(!hasAuthoritativeFacade || authoritativeLoaded) && !(hasAuthoritativeFacade && relationshipQuery.isError) ? (
                  <span className="sh-skill-drawer__relation-count">
                    {hasUnresolvedTargets
                      ? t("skillLibrary.drawer.values.knownDestinationCount", { count })
                      : count}
                  </span>
                ) : null}
              </div>
              {groupContent(kind, regionLabel)}
            </div>
          );
        })}
      </div>

      {hasAuthoritativeFacade && relationshipQuery.isError ? (
        <div className="sh-skill-drawer__query-error" role="alert">
          <p>{t("skillLibrary.drawer.relationships.loadFailed")}</p>
          <Button onClick={() => void relationshipQuery.refetch()} size="sm" variant="ghost">{t("actions.retry")}</Button>
          <Link className="sh-button sh-button--secondary sh-button--sm" state={returnState} to={governanceHref}>
            {t("skillLibrary.drawer.reviewRelationships")}
          </Link>
        </div>
      ) : null}

      {hasUnresolvedTargets ? (
        <div className="sh-skill-drawer__unresolved" role="status">
          <Icon aria-hidden="true" name="info" size={16} />
          <p>{t("skillLibrary.drawer.unresolvedTargets", { count: unresolvedCount })}</p>
          {authoritativeLoaded ? (
            <ul className="sh-skill-drawer__unresolved-list">
              {unresolvedTargets.map((relation) => (
                <li key={relation.relationId}>
                  <code title={displayPath(relation.path)}>{displayPath(relation.path) || t("skillLibrary.drawer.values.unknownTarget")}</code>
                  <Link
                    aria-label={t("skillLibrary.drawer.reviewUnresolvedRelationship")}
                    className="sh-button sh-button--ghost sh-button--sm"
                    state={returnState}
                    to={relationHref(relation.relationId)}
                  >
                    {t("skillLibrary.drawer.reviewUnresolvedRelationship")}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <Link className="sh-button sh-button--ghost sh-button--sm" state={returnState} to={governanceHref}>
            {t("skillLibrary.drawer.reviewRelationships")}
          </Link>
        </div>
      ) : null}

      {hasAuthoritativeFacade ? (
        <div className="sh-skill-drawer__provenance">
          <strong>{t("skillLibrary.drawer.provenance.label")}</strong>
          {provenanceQuery.isPending ? (
            <span role="status">{t("skillLibrary.drawer.relationships.loading")}</span>
          ) : provenanceQuery.isError ? (
            <div className="sh-skill-drawer__query-error" role="alert">
              <p>{t("skillLibrary.drawer.provenance.loadFailed")}</p>
              <Button onClick={() => void provenanceQuery.refetch()} size="sm" variant="ghost">{t("actions.retry")}</Button>
            </div>
          ) : provenanceQuery.data?.provenance ? (
            <div className="sh-skill-drawer__provenance-fact">
              <span>{t(`skillDetail.provenance.sourceKinds.${provenanceQuery.data.provenance.sourceKind}`, { defaultValue: t("skillLibrary.drawer.provenance.otherSource") })}</span>
              <code title={displayPath(provenanceQuery.data.provenance.sourceLocator)}>
                {displayPath(provenanceQuery.data.provenance.sourceLocator)}
              </code>
            </div>
          ) : (
            <span>{t("skillLibrary.drawer.provenance.none")}</span>
          )}
        </div>
      ) : null}
    </ModuleCard>
  );
}

function SourceLicenseModule({ versionsHref, versionsState, view }: ModuleProps) {
  const { t } = useTranslation();
  return (
    <ModuleCard title={t("skillLibrary.drawer.modules.sourceVersion")}>
      <dl className="sh-skill-drawer__facts sh-skill-drawer__facts--stacked">
        <div><dt>{t("skillLibrary.drawer.values.source")}</dt><dd>{view.source ?? <EmptyValue />}</dd></div>
        <div><dt>{t("skillLibrary.drawer.modules.versions")}</dt><dd>{view.currentVersion}</dd></div>
        <div><dt>{t("skillLibrary.drawer.values.ownership")}</dt><dd>{view.ownership ?? <EmptyValue />}</dd></div>
        <div><dt>{t("skillLibrary.drawer.values.license")}</dt><dd>{view.license ?? <EmptyValue />}</dd></div>
      </dl>
      {view.upgradeAvailable ? (
        <div className="sh-skill-drawer__version-update">
          <Icon name="info" /><strong>{t("skillLibrary.drawer.values.updateAvailable")}</strong>
          {versionsHref ? <Link className="sh-button sh-button--secondary sh-button--sm" state={versionsState} to={versionsHref}>{t("skillLibrary.drawer.viewUpdate")}</Link> : null}
        </div>
      ) : <p className="sh-skill-drawer__secondary">{t("skillLibrary.drawer.values.upToDate")}</p>}
    </ModuleCard>
  );
}

function SecurityChecksModule({ securityFacade, view }: ModuleRendererProps) {
  const { t } = useTranslation();
  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.security_checks)}>
      <RiskSummary view={view} />
      {view.currentVersionId ? (
        <SecurityResults
          facade={securityFacade}
          skillId={view.id}
          variant="drawer"
          versionId={view.currentVersionId}
        />
      ) : (
        <DataState
          message={t("skillDetail.states.noCurrentVersionForSecurity")}
          state="empty"
        />
      )}
    </ModuleCard>
  );
}

function UsageEvidenceModule({ view }: ModuleProps) {
  const { t } = useTranslation();
  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.usage_evidence)}>
      {view.usageEvidence ? (
        <>
          <p>
            {t("skillLibrary.drawer.values.invocationCount", {
              count: view.usageEvidence.invocationCount,
            })}
          </p>
          {view.usageEvidence.lastUsedAt ? (
            <p className="sh-skill-drawer__secondary">
              {t("skillLibrary.drawer.values.lastUsed", {
                value: view.usageEvidence.lastUsedAt,
              })}
            </p>
          ) : null}
        </>
      ) : (
        <EmptyValue />
      )}
    </ModuleCard>
  );
}

const OPTIONAL_MODULE_RENDERERS: Record<
  (typeof FIXED_DRAWER_MODULE_ORDER)[number],
  ComponentType<ModuleRendererProps>
> = {
  relations: RelationsModule,
  security_checks: SecurityChecksModule,
  source_license: SourceLicenseModule,
  usage_evidence: UsageEvidenceModule,
};

interface IdentityRegionProps extends ModuleProps {
  editingField?: "alias" | "note" | "purpose";
  editingValue: string;
  onAddTags: () => void;
  onTrialChange: (due: string | null) => void;
  facade: SkillLibraryFacade;
  onBeginEdit: (field: "alias" | "note" | "purpose") => void;
  onChange: (value: string) => void;
  onCommit: () => void;
  onRemoveTag: (tag: string) => void;
  onTranslateDescription?: () => void;
  onConfirmTranslation?: () => void;
  onCancelTranslation?: () => void;
  translationDraft?: string;
  translationError?: string;
  translationLoading?: boolean;
  trialFacade?: Pick<SkillDetailFacade, "setTrial">;
}

interface TrialReviewActionsProps {
  facade?: Pick<SkillDetailFacade, "setTrial">;
  lifecycle: SkillQuickView["lifecycle"];
  onTrialChange: (due: string | null) => void;
  skillId: string;
  trialDue?: string;
}

function CalendarIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24" width="16">
      <rect height="16" rx="2" width="18" x="3" y="5" />
      <path d="M16 3v4M8 3v4M3 10h18M8 14h2M14 14h2M8 18h2" />
    </svg>
  );
}

function TrialReviewActions({ facade, lifecycle, onTrialChange, skillId, trialDue }: TrialReviewActionsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const notifications = useOptionalAppNotifications();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(trialDue ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number }>();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dateRef = useRef<HTMLInputElement | null>(null);
  const setPopoverRef = useCallback((node: HTMLDivElement | null) => setContentNode(node), []);

  useEffect(() => setDate(trialDue ?? ""), [trialDue]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const content = contentNode;
    if (!trigger || !content) return;
    const triggerRect = trigger.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const gutter = 12;
    const gap = 8;
    const maxHeight = Math.max(120, window.innerHeight - gutter * 2);
    const actualHeight = Math.min(contentRect.height, maxHeight);
    const below = window.innerHeight - triggerRect.bottom - gutter - gap;
    const top = below >= actualHeight
      ? triggerRect.bottom + gap
      : Math.max(gutter, triggerRect.top - actualHeight - gap);
    const left = Math.max(gutter, Math.min(triggerRect.left, window.innerWidth - contentRect.width - gutter));
    setPosition({ left, top, maxHeight });
  }, [contentNode]);

  useLayoutEffect(() => {
    if (!open || !contentNode) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(updatePosition);
    observer?.observe(contentNode);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      observer?.disconnect();
    };
  }, [contentNode, open, updatePosition]);

  const saveTrialDate = async (due: string | null) => {
    if (!facade || pending || (due !== null && !due)) return;
    setPending(true);
    setError(undefined);
    setMessage(undefined);
    const translate = (key: string, options?: Record<string, unknown>) =>
      String(t(key as never, options as never));
    const describeFailure = (reason: unknown) =>
      describeNativeError(reason, translate, "skillDetail.tracker.failureUnknown");
    const noticeTitle = due
      ? t("skillDetail.trial.saved", { date: due })
      : t("skillLibrary.drawer.trial.converted");
    try {
      await runTrackedOperation({
        kind: "trial_review_date",
        label: t("skillDetail.trial.saveDate"),
        mode: "instant",
        notifications,
        source: "library",
        translate,
        successNotice: () => ({ tone: "success", title: noticeTitle }),
        errorNotice: (_reason, detail) => {
          setError(detail);
          return { tone: "danger", title: t("skillDetail.trial.saveError"), detail };
        },
        describeError: describeFailure,
        queryClient,
        invalidateQueryKeys: [skillDetailKeys.summary(skillId), skillLibraryKeys.root],
        run: () => facade.setTrial(skillId, due),
      });
      onTrialChange(due);
      setMessage(noticeTitle);
      setOpen(false);
    } catch {
      setError((current) => current ?? t("skillDetail.trial.saveError"));
    } finally {
      setPending(false);
    }
  };

  if (!facade) return null;

  return (
    <div className="sh-skill-drawer__trial-controls">
      {lifecycle === "trial" ? (
        <>
          <span className="sh-skill-drawer__trial-date" title={trialDue ?? t("skillLibrary.drawer.trial.noDate")}>
            {trialDue ?? t("skillLibrary.drawer.trial.noDate")}
          </span>
          <Dialog.Root onOpenChange={(nextOpen) => {
            setOpen(nextOpen);
            if (nextOpen) {
              setDate(trialDue ?? "");
              setError(undefined);
            }
          }} open={open}>
            <Dialog.Trigger asChild>
              <Button
                aria-label={t("skillLibrary.drawer.trial.adjustDate")}
                className="sh-skill-drawer__trial-date-trigger"
                data-tooltip={t("skillLibrary.drawer.trial.adjustDate")}
                onClick={() => setMessage(undefined)}
                ref={triggerRef}
                size="sm"
                variant="ghost"
              >
                <CalendarIcon />
              </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Content
                aria-describedby={undefined}
                className="sh-skill-drawer__trial-popover"
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  triggerRef.current?.focus();
                }}
                onEscapeKeyDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                }}
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  dateRef.current?.focus();
                }}
                ref={setPopoverRef}
                role="dialog"
                style={{
                  left: position?.left ?? 12,
                  maxHeight: position?.maxHeight ?? "calc(100vh - 24px)",
                  top: position?.top ?? 12,
                  visibility: position ? "visible" : "hidden",
                }}
              >
                <Dialog.Title>{t("skillLibrary.drawer.trial.reviewDate")}</Dialog.Title>
                <label className="sh-skill-drawer__trial-input">
                  <span>{t("skillLibrary.drawer.trial.reviewDateLabel")}</span>
                  <input
                    ref={dateRef}
                    onChange={(event) => setDate(event.currentTarget.value)}
                    type="date"
                    value={date}
                  />
                </label>
                {error ? <p className="sh-skill-drawer__trial-error" role="alert">{error}</p> : null}
                <div className="sh-skill-drawer__trial-popover-actions">
                  <Button disabled={!date || pending} loading={pending} onClick={() => void saveTrialDate(date)} size="sm">
                    {t("skillLibrary.drawer.trial.saveDate")}
                  </Button>
                  <Button disabled={pending} onClick={() => setOpen(false)} size="sm" variant="ghost">
                    {t("actions.cancel")}
                  </Button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <Button
            className="sh-skill-drawer__trial-convert"
            disabled={pending}
            loading={pending}
            onClick={() => void saveTrialDate(null)}
            size="sm"
            variant="secondary"
          >
            {t("skillLibrary.drawer.trial.convert")}
          </Button>
        </>
      ) : (
        <Dialog.Root onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            setDate("");
            setError(undefined);
          }
        }} open={open}>
          <Dialog.Trigger asChild>
            <Button
              aria-label={t("skillDetail.trial.set")}
              onClick={() => setMessage(undefined)}
              ref={triggerRef}
              size="sm"
              variant="ghost"
            >
              {t("skillDetail.trial.set")}
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Content
              aria-describedby={undefined}
              className="sh-skill-drawer__trial-popover"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                triggerRef.current?.focus();
              }}
              onEscapeKeyDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                dateRef.current?.focus();
              }}
              ref={setPopoverRef}
              role="dialog"
              style={{
                left: position?.left ?? 12,
                maxHeight: position?.maxHeight ?? "calc(100vh - 24px)",
                top: position?.top ?? 12,
                visibility: position ? "visible" : "hidden",
              }}
            >
              <Dialog.Title>{t("skillLibrary.drawer.trial.reviewDate")}</Dialog.Title>
              <label className="sh-skill-drawer__trial-input">
                <span>{t("skillLibrary.drawer.trial.reviewDateLabel")}</span>
                <input ref={dateRef} onChange={(event) => setDate(event.currentTarget.value)} type="date" value={date} />
              </label>
              {error ? <p className="sh-skill-drawer__trial-error" role="alert">{error}</p> : null}
              <div className="sh-skill-drawer__trial-popover-actions">
                <Button disabled={!date || pending} loading={pending} onClick={() => void saveTrialDate(date)} size="sm">
                  {t("skillLibrary.drawer.trial.saveDate")}
                </Button>
                <Button disabled={pending} onClick={() => setOpen(false)} size="sm" variant="ghost">
                  {t("actions.cancel")}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      {error && !open ? <p className="sh-skill-drawer__trial-error" role="alert">{error}</p> : null}
      {message ? <span aria-live="polite" className="sh-visually-hidden">{message}</span> : null}
    </div>
  );
}

function CombinationMembership({ facade, skillId, skillName }: {
  facade: SkillLibraryFacade;
  skillId: string;
  skillName: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pendingName, setPendingName] = useState<string>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number }>();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const hasContract = Boolean(facade.listCombinations && facade.updateCombination);
  const query = useQuery({
    enabled: hasContract,
    queryFn: () => facade.listCombinations!(),
    queryKey: ["skill-combinations"],
  });
  const combinations: CombinationResult[] = query.data ?? [];
  const currentMemberships = combinations.filter((combination) => combination.members.includes(skillId));
  const setPopoverRef = useCallback((node: HTMLDivElement | null) => setContentNode(node), []);
  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || !contentNode) return;
    const triggerRect = trigger.getBoundingClientRect();
    const contentRect = contentNode.getBoundingClientRect();
    const gutter = 12;
    const gap = 8;
    const maxHeight = Math.max(120, window.innerHeight - gutter * 2);
    const actualHeight = Math.min(contentRect.height, maxHeight);
    const below = window.innerHeight - triggerRect.bottom - gutter - gap;
    const top = below >= actualHeight
      ? triggerRect.bottom + gap
      : Math.max(gutter, triggerRect.top - actualHeight - gap);
    const left = Math.max(gutter, Math.min(triggerRect.left, window.innerWidth - contentRect.width - gutter));
    setPosition({ left, top, maxHeight });
  }, [contentNode]);

  useLayoutEffect(() => {
    if (!open || !contentNode) return;
    updatePopoverPosition();
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(updatePopoverPosition);
    observer?.observe(contentNode);
    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
      observer?.disconnect();
    };
  }, [contentNode, open, updatePopoverPosition]);

  if (!hasContract) return null;

  const updateMembership = async (combination: CombinationResult, shouldRemove: boolean) => {
    if (!facade.updateCombination || pendingName) return;
    setPendingName(combination.name);
    setError(undefined);
    setStatus(undefined);
    const nextMembers = shouldRemove
      ? combination.members.filter((member) => member !== skillId)
      : [...combination.members, skillId];
    try {
      await facade.updateCombination(combination.name, nextMembers);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["skill-combinations"] }),
        queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root }),
      ]);
      setOpen(false);
      setStatus(t(shouldRemove
        ? "skillLibrary.drawer.collections.removed"
        : "skillLibrary.drawer.collections.added", { name: combination.name }));
    } catch (reason: unknown) {
      setError(describeNativeError(
        reason,
        (key, options) => String(t(key as never, options as never)),
        "skillLibrary.combinations.errors.generic",
      ));
    } finally {
      setPendingName(undefined);
    }
  };

  return (
    <div className="sh-skill-drawer__collections">
      <span className="sh-skill-drawer__field-label">{t("skillLibrary.drawer.collections.label")}</span>
      <div className="sh-skill-drawer__collections-value">
        {query.isPending ? <span className="sh-skill-drawer__secondary">{t("skillLibrary.combinations.loading")}</span> : null}
        {query.isError ? (
          <span className="sh-skill-drawer__alert-inline" role="alert">{t("skillLibrary.drawer.collections.loadFailed")}</span>
        ) : null}
        {currentMemberships.length > 0 ? (
          <ul aria-label={t("skillLibrary.drawer.collections.memberships")} className="sh-skill-drawer__collection-chips">
            {currentMemberships.map((combination) => (
              <li className="sh-skill-drawer__collection-chip" key={combination.name}>
                <span title={combination.name}>{combination.name}</span>
                <Button
                  aria-label={t("skillLibrary.drawer.collections.remove", { skill: skillName, name: combination.name })}
                  className="sh-skill-drawer__collection-remove"
                  disabled={Boolean(pendingName)}
                  loading={pendingName === combination.name}
                  onClick={() => void updateMembership(combination, true)}
                  size="sm"
                  variant="ghost"
                >
                  <span aria-hidden="true">−</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : !query.isPending && !query.isError ? (
          <span className="sh-skill-drawer__secondary">{t("skillLibrary.drawer.collections.none")}</span>
        ) : null}
        <Dialog.Root onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            setError(undefined);
            setStatus(undefined);
          }
        }} open={open}>
          <Dialog.Trigger asChild>
            <Button
              aria-label={t("skillLibrary.drawer.collections.add")}
              className="sh-skill-drawer__collection-add"
              data-tooltip={t("skillLibrary.drawer.collections.add")}
              disabled={Boolean(pendingName) || query.isPending || query.isError}
              onClick={() => setStatus(undefined)}
              ref={triggerRef}
              size="sm"
              variant="ghost"
            >
              <span aria-hidden="true">+</span>
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Content
              aria-describedby={undefined}
              className="sh-skill-drawer__collections-popover"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                triggerRef.current?.focus();
              }}
              onEscapeKeyDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }}
              onOpenAutoFocus={(event) => event.preventDefault()}
              ref={setPopoverRef}
              role="dialog"
              style={{
                left: position?.left ?? 12,
                maxHeight: position?.maxHeight ?? "calc(100vh - 24px)",
                top: position?.top ?? 12,
                visibility: position ? "visible" : "hidden",
              }}
            >
              <Dialog.Title>{t("skillLibrary.drawer.collections.dialogTitle", { skill: skillName })}</Dialog.Title>
              {error ? <p className="sh-skill-drawer__alert-inline" role="alert">{error}</p> : null}
              {combinations.length > 0 ? (
                <ul className="sh-skill-drawer__collection-options">
                  {combinations.map((combination) => {
                    const isMember = combination.members.includes(skillId);
                    return (
                      <li key={combination.name}>
                        <span title={combination.name}>{combination.name}</span>
                        <Button
                          aria-label={isMember
                            ? t("skillLibrary.drawer.collections.remove", { skill: skillName, name: combination.name })
                            : t("skillLibrary.drawer.collections.addTo", { name: combination.name })}
                          disabled={Boolean(pendingName)}
                          loading={pendingName === combination.name}
                          onClick={() => void updateMembership(combination, isMember)}
                          size="sm"
                          variant={isMember ? "ghost" : "secondary"}
                        >
                          {isMember
                            ? t("skillLibrary.drawer.collections.removeShort")
                            : t("skillLibrary.drawer.collections.addShort")}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="sh-skill-drawer__collections-empty">
                  <p>{t("skillLibrary.drawer.collections.empty")}</p>
                  <Link to="/library/combinations">{t("skillLibrary.drawer.collections.manage")}</Link>
                </div>
              )}
              <Button className="sh-skill-drawer__collections-close" onClick={() => setOpen(false)} size="sm" variant="ghost">
                {t("actions.close")}
              </Button>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        {query.isError ? (
          <Button onClick={() => void query.refetch()} size="sm" variant="ghost">{t("actions.retry")}</Button>
        ) : null}
      </div>
      {error ? <p className="sh-skill-drawer__alert-inline" role="alert">{error}</p> : null}
      {status ? <p aria-live="polite" className="sh-visually-hidden">{status}</p> : null}
    </div>
  );
}

function PencilIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="m15 5 4 4M4 20l4.3-1 11.3-11.3a2.1 2.1 0 0 0-3-3L5.3 16 4 20Z" />
    </svg>
  );
}

function PinnedDrawerTitle({ name }: { name: string }) {
  return (
    <div className="sh-skill-drawer__pinned-title">
      <h2>{name}</h2>
    </div>
  );
}

function IdentityRegion({
  editingField,
  editingValue,
  onAddTags,
  onTrialChange,
  onBeginEdit,
  facade,
  onChange,
  onCommit,
  onRemoveTag,
  onCancelTranslation,
  onConfirmTranslation,
  onTranslateDescription,
  translationDraft,
  translationError,
  translationLoading = false,
  trialFacade,
  view,
}: IdentityRegionProps) {
  const { t } = useTranslation();
  const tagPopover = useBoundedPopover();
  const tagPopoverId = useId();
  const displayedTags = view.tags.slice(0, MAX_VISIBLE_TAGS);
  const hiddenTagCount = Math.max(0, view.tags.length - displayedTags.length);
  const toggleTagPopover = (event: ReactPointerEvent<HTMLButtonElement>) => {
    tagPopover.triggerRef.current = event.currentTarget;
    if (tagPopover.open) tagPopover.close(true);
    else tagPopover.setOpen(true);
  };
  return (
    <section className="sh-skill-drawer__identity sh-skill-drawer__overview">
      <div className="sh-skill-drawer__identity-heading">
        {/* 别名时仍在可滚正文中保留原始运行时名称，不把它挤进固定标题区。 */}
        {view.originalName && view.originalName !== view.name ? (
          <span className="sh-skill-drawer__original-name">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.drawer.values.originalName")}:
            </span>{" "}
            <span>{view.originalName}</span>
          </span>
        ) : null}
        <div className="sh-skill-drawer__summary-grid">
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--alias">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.drawer.values.alias")}
            </span>
            <div className="sh-skill-drawer__summary-value">
              {editingField === "alias" ? (
                <input
                  aria-label={t("skillLibrary.drawer.values.alias")}
                  autoFocus
                  onBlur={onCommit}
                  onChange={(event) => onChange(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onCommit();
                    if (event.key === "Escape") onCommit();
                  }}
                  type="text"
                  value={editingValue}
                />
              ) : (
                <span>{view.alias ?? <EmptyValue />}</span>
              )}
              <Button
                aria-label={t("skillLibrary.drawer.editAlias")}
                className="sh-skill-drawer__edit-icon"
                data-tooltip={t("skillLibrary.drawer.editAlias")}
                onClick={() => onBeginEdit("alias")}
                size="sm"
                variant="ghost"
              >
                <PencilIcon />
              </Button>
            </div>
          </div>
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--tags">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.drawer.values.tags")}
            </span>
            <div className="sh-skill-drawer__summary-value sh-skill-drawer__summary-tags">
              {view.tags.length > 0 ? (
                <ul className="sh-skill-drawer__tag-list">
                  {displayedTags.map((tag) => (
                    <li className="sh-skill-drawer__tag" key={tag}>
                      <span title={tag}>{tag}</span>
                      <Button
                        aria-label={t("skillLibrary.drawer.removeTag", { tag })}
                        onClick={() => onRemoveTag(tag)}
                        size="sm"
                        variant="ghost"
                      >
                        <Icon name="close" size={16} />
                      </Button>
                    </li>
                  ))}
                  {hiddenTagCount > 0 ? (
                    <li className="sh-skill-drawer__tag-more">
                      <Button
                        aria-controls={tagPopoverId}
                        aria-expanded={tagPopover.open}
                        className="sh-skill-drawer__tag-more-button"
                        onClick={toggleTagPopover}
                        size="sm"
                        variant="secondary"
                      >
                        {t("skillLibrary.drawer.moreTags", { count: hiddenTagCount })}
                      </Button>
                    </li>
                  ) : null}
                </ul>
              ) : (
                <EmptyValue />
              )}
              <Button
                aria-label={t("skillLibrary.drawer.actions.addTags")}
                className="sh-skill-drawer__edit-icon"
                data-tooltip={t("skillLibrary.drawer.actions.addTags")}
                onClick={onAddTags}
                size="sm"
                variant="ghost"
              >
                <PencilIcon />
              </Button>
              {tagPopover.open ? (
                <DrawerBoundedPopover
                  ariaLabel={t("skillLibrary.drawer.allTags")}
                  className="sh-skill-drawer__tag-popover"
                  contentRef={tagPopover.contentRef}
                  id={tagPopoverId}
                  onCloseAutoFocus={tagPopover.onCloseAutoFocus}
                  onOpenChange={tagPopover.onOpenChange}
                  open={tagPopover.open}
                  position={tagPopover.position}
                  setPosition={tagPopover.setPosition}
                  triggerRef={tagPopover.triggerRef}
                >
                  <div className="sh-skill-drawer__tag-popover-heading">
                    <strong>{t("skillLibrary.drawer.allTags")}</strong>
                    <Button
                      aria-label={t("actions.close")}
                      onClick={() => tagPopover.close(true)}
                      size="sm"
                      variant="ghost"
                    >
                      <Icon name="close" size={16} />
                    </Button>
                  </div>
                  <ul>
                    {view.tags.map((tag) => (
                      <li key={tag}>
                        <span title={tag}>{tag}</span>
                        <Button
                          aria-label={t("skillLibrary.drawer.removeTag", { tag })}
                          onClick={() => onRemoveTag(tag)}
                          size="sm"
                          variant="ghost"
                        >
                          <Icon name="close" size={16} />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </DrawerBoundedPopover>
              ) : null}
            </div>
          </div>
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--lifecycle">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.filters.lifecycle")}
            </span>
            <div className="sh-skill-drawer__lifecycle-row">
              <span className="sh-skill-drawer__summary-value sh-skill-drawer__lifecycle-value">
                {t(LIFECYCLE_LABEL_KEYS[view.lifecycle])}
              </span>
              <TrialReviewActions
                facade={trialFacade}
                lifecycle={view.lifecycle}
                onTrialChange={onTrialChange}
                skillId={view.id}
                trialDue={view.trialDue}
              />
            </div>
          </div>
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--version">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.filters.version")}
            </span>
            <span className="sh-skill-drawer__summary-value">{view.currentVersion}</span>
          </div>
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--agents">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.drawer.values.agentDestinations")}
            </span>
            <span className="sh-skill-drawer__summary-value">
              {view.unresolvedDeploymentCount
                ? t("skillLibrary.drawer.values.knownDestinationCount", { count: view.agentDeploymentCount })
                : view.agentDeploymentCount}
            </span>
          </div>
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--projects">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.drawer.values.projectDestinations")}
            </span>
            <span className="sh-skill-drawer__summary-value">
              {view.unresolvedDeploymentCount
                ? t("skillLibrary.drawer.values.knownDestinationCount", { count: view.projectDeploymentCount })
                : view.projectDeploymentCount}
            </span>
          </div>
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--invocation">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.drawer.values.invocation")}
            </span>
            <span className="sh-skill-drawer__summary-value">
              <InvocationBadge policy={view.invocationPolicy} />
            </span>
          </div>
          {view.requirements.length > 0 ? (
            <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--requirements">
              <span className="sh-skill-drawer__field-label">
                {t("skillLibrary.drawer.values.requirements")}
              </span>
              <span className="sh-skill-drawer__summary-value">
                {view.requirements.join(" · ")}
              </span>
            </div>
          ) : null}
        </div>
        <CombinationMembership facade={facade} skillId={view.id} skillName={view.name} />
      </div>
      <div className="sh-skill-drawer__field sh-skill-drawer__description-block">
        <span className="sh-skill-drawer__field-label">
          {t("skillLibrary.drawer.values.originalDescription")}:
        </span>
        <span className="sh-skill-drawer__field-value">
          {view.originalDescription ?? <EmptyValue />}
        </span>
        {onTranslateDescription ? (
          <Button
            disabled={translationLoading}
            onClick={onTranslateDescription}
            size="sm"
            variant="ghost"
          >
            {translationLoading
              ? t("skillLibrary.drawer.translation.inProgress")
              : t("skillLibrary.drawer.translation.action")}
          </Button>
        ) : null}
        {translationError ? <p role="alert">{translationError}</p> : null}
        {translationDraft ? (
          <div aria-label={t("skillLibrary.drawer.translation.confirmLabel")} role="alertdialog">
            <p>{translationDraft}</p>
            <Button onClick={onConfirmTranslation} size="sm">
              {t("skillLibrary.drawer.translation.useAsPurpose")}
            </Button>
            <Button onClick={onCancelTranslation} size="sm" variant="ghost">
              {t("actions.cancel")}
            </Button>
          </div>
        ) : null}
      </div>
      {view.translatedDescription ? (
        <div className="sh-skill-drawer__field">
          <span className="sh-skill-drawer__field-label">
            {t("skillLibrary.drawer.values.translatedDescription")}:
          </span>
          <span className="sh-skill-drawer__field-value sh-skill-drawer__secondary">
            {view.translatedDescription}
          </span>
        </div>
      ) : null}
      {/* M-21 #6：“我的用途”在抽屉内提供编辑入口；用途是用户独立撰写的
          元数据（QA-008），与原始描述/译文分开保存。 */}
      <div className="sh-skill-drawer__purpose-row">
        <span className="sh-skill-drawer__field-label">
          {t("skillLibrary.drawer.values.purpose")}:
        </span>
        {editingField === "purpose" ? (
          <input
            aria-label={t("skillLibrary.drawer.values.purpose")}
            autoFocus
            onBlur={onCommit}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommit();
              if (event.key === "Escape") onCommit();
            }}
            type="text"
            value={editingValue}
          />
        ) : (
          <span className="sh-skill-drawer__field-value">
            {view.purpose || <EmptyValue />}
          </span>
        )}
        <Button
          aria-label={t("skillLibrary.drawer.editPurpose")}
          className="sh-skill-drawer__edit-icon"
          data-tooltip={t("skillLibrary.drawer.editPurpose")}
          onClick={() => onBeginEdit("purpose")}
          size="sm"
          variant="ghost"
        >
          <PencilIcon />
        </Button>
      </div>
      <div className="sh-skill-drawer__note">
        <span className="sh-skill-drawer__note-label">
          {t("skillLibrary.drawer.values.note")}:
        </span>
        {editingField === "note" ? (
          <input
            aria-label={t("skillLibrary.drawer.values.note")}
            autoFocus
            onBlur={onCommit}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommit();
              if (event.key === "Escape") onCommit();
            }}
            type="text"
            value={editingValue}
          />
        ) : (
          <span className="sh-skill-drawer__secondary">
            {view.note ?? <EmptyValue />}
          </span>
        )}
        <Button
          aria-label={t("skillLibrary.drawer.editNote")}
          className="sh-skill-drawer__edit-icon"
          data-tooltip={t("skillLibrary.drawer.editNote")}
          onClick={() => onBeginEdit("note")}
          size="sm"
          variant="ghost"
        >
          <PencilIcon />
        </Button>
      </div>
    </section>
  );
}

interface PrimaryActionsProps {
  onDelete?: (skillId: string, skillName: string) => void;
  view?: SkillQuickView;
}

function PrimaryActions({
  onDelete,
  view,
}: PrimaryActionsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (!view) return null;
  return (
    <div aria-label={t(MODULE_LABEL_KEYS.primary_actions)} className="sh-skill-drawer__header-actions">
      <Button
        aria-label={t("skillLibrary.drawer.actions.dispatchSkill", { name: view.name })}
        className="sh-skill-drawer__dispatch"
        onClick={() => navigate(`/deploy?skill=${encodeURIComponent(view.id)}`)}
        size="sm"
        variant="primary"
      >
        {t("skillLibrary.drawer.actions.dispatch")}
      </Button>
      <Button
        aria-label={t("skillLibrary.drawer.actions.exportSkill", { name: view.name })}
        onClick={() => navigate("/settings/data-protection", { state: { exportSkillIds: [view.id] } })}
        size="sm"
        variant="secondary"
      >
        {t("skillLibrary.drawer.actions.export")}
      </Button>
      {onDelete ? (
        <Button
          aria-label={t("skillLibrary.drawer.actions.delete")}
          className="sh-skill-drawer__delete-action"
          onClick={() => onDelete(view.id, view.name)}
          size="sm"
          variant="danger"
        >
          {t("skillLibrary.drawer.actions.deleteShort")}
        </Button>
      ) : null}
    </div>
  );
}

function RiskSummary({ view }: ModuleProps) {
  const { t } = useTranslation();
  return (
    <section aria-label={t(MODULE_LABEL_KEYS.risk_summary)} className="sh-skill-drawer__risk">
      <strong>{t(MODULE_LABEL_KEYS.risk_summary)}</strong>
      <span>{t("skillLibrary.drawer.risk.high", { count: view.highRiskCount })}</span>
      <span>{t("skillLibrary.drawer.risk.pending", { count: view.pendingCount })}</span>
    </section>
  );
}

interface DragSession {
  handle: HTMLDivElement;
  lastWidth: number;
  pointerId: number;
  startWidth: number;
  startX: number;
}

type DrawerPanelStyle = CSSProperties & {
  "--skill-drawer-width": string;
};

function viewportWidth() {
  return typeof window === "undefined" ? 1024 : window.innerWidth;
}

export function SkillQuickDrawer({
  detailSearch = "",
  drawerPrototype = false,
  facade,
  libraryReturn,
  onDelete,
  onOpenChange,
  onPreferencesChange,
  open,
  preferenceSaveFailed,
  preferences,
  refreshSnapshot,
  relationshipFacade,
  securityFacade,
  trialFacade,
  returnFocusRef,
  skillId,
}: SkillQuickDrawerProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [editingField, setEditingField] = useState<"alias" | "note" | "purpose">();
  const [editingValue, setEditingValue] = useState("");
  const [localPreferenceSaveFailed, setLocalPreferenceSaveFailed] = useState(false);
  const [metadataSaveFailed, setMetadataSaveFailed] = useState(false);
  const [tagsSaveFailed, setTagsSaveFailed] = useState(false);
  const [localView, setLocalView] = useState<SkillQuickView>();
  const [translationDraft, setTranslationDraft] = useState<string>();
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationError, setTranslationError] = useState<string>();
  // 抽屉只经对话框批量添加标签；移除走逐个 chip（onRemoveTag → saveTags）。
  const [tagAction, setTagAction] = useState<Extract<BatchTagAction, "add_tag">>();
  const dragSessionRef = useRef<DragSession>();
  const drawerLayoutRef = useRef<HTMLDivElement | null>(null);
  const preferenceSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const preferenceSaveRequestRef = useRef(0);
  const removePointerListenersRef = useRef<() => void>(() => undefined);
  const normalizedPreferences = normalizeDrawerPreferences(preferences);
  const prototypeEnabled = import.meta.env.DEV && drawerPrototype;
  const fullDetailsSearch = prototypeEnabled ? (() => {
    const search = new URLSearchParams(detailSearch);
    search.set("detailPrototype", "review");
    return `?${search.toString()}`;
  })() : detailSearch;
  const drawerViewportWidth = viewportWidth();
  const drawerMaximumWidth = Math.max(420, drawerViewportWidth - 32);
  const effectiveWidth = clampDrawerWidth(
    normalizedPreferences.widthPx,
    drawerViewportWidth,
  );
  // 拖拽宽度是瞬态值：直接写 CSS 变量与 aria 属性，不进 state，
  // 避免 pointermove 频率触发整个抽屉重渲染；结束时才持久化偏好。
  const applyDragWidth = (widthPx: number) => {
    const panel = document.querySelector<HTMLElement>('[data-testid="drawer-panel"]');
    panel?.style.setProperty("--skill-drawer-width", `${widthPx}px`);
    drawerLayoutRef.current?.style.setProperty("--skill-drawer-width", `${widthPx}px`);
    dragSessionRef.current?.handle.setAttribute("aria-valuenow", String(widthPx));
  };
  const panelStyle: DrawerPanelStyle = {
    "--skill-drawer-width": `${effectiveWidth}px`,
  };
  const detailQuery = useQuery({
    enabled: open && Boolean(skillId),
    queryFn: () => {
      if (!skillId) {
        throw new Error("A Skill ID is required for the quick view query.");
      }
      return facade.getSkillQuickView(skillId);
    },
    queryKey: skillLibraryKeys.quickView(skillId ?? ""),
  });

  const persistPreferences = (next: SkillDrawerPreferences) => {
    const normalized = normalizeDrawerPreferences(next);
    const request = preferenceSaveRequestRef.current + 1;
    preferenceSaveRequestRef.current = request;
    setLocalPreferenceSaveFailed(false);
    onPreferencesChange(normalized);
    const save = preferenceSaveQueueRef.current.then(() =>
      facade.saveDrawerPreferences(normalized),
    );
    preferenceSaveQueueRef.current = save.then(
      () => undefined,
      () => undefined,
    );
    void save.then(
      () => {
        if (request === preferenceSaveRequestRef.current) {
          setLocalPreferenceSaveFailed(false);
        }
      },
      () => {
        if (request === preferenceSaveRequestRef.current) {
          setLocalPreferenceSaveFailed(true);
        }
      },
    );
  };

  const choosePreset = (preset: DrawerPreset) => {
    persistPreferences({
      ...normalizedPreferences,
      preset,
      widthPx: drawerWidthForPreset(preset, drawerViewportWidth),
    });
  };

  const cyclePreset = () => {
    const currentIndex = DRAWER_PRESET_CYCLE.indexOf(normalizedPreferences.preset);
    const nextPreset = DRAWER_PRESET_CYCLE[(currentIndex + 1) % DRAWER_PRESET_CYCLE.length];
    choosePreset(nextPreset);
  };

  const completeResize = (pointerId: number, persistWidth: boolean) => {
    const session = dragSessionRef.current;
    if (!session || pointerId !== session.pointerId) {
      return;
    }
    removePointerListenersRef.current();
    dragSessionRef.current = undefined;
    // 恢复为当前偏好的宽度（取消）或等待持久化后的重渲染（确认）。
    applyDragWidth(effectiveWidth);
    if (
      typeof session.handle.hasPointerCapture === "function" &&
      session.handle.hasPointerCapture(session.pointerId)
    ) {
      session.handle.releasePointerCapture(session.pointerId);
    }
    if (persistWidth) {
      persistPreferences({
        ...normalizedPreferences,
        widthPx: session.lastWidth,
      });
    }
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const activeSession = dragSessionRef.current;
    if (activeSession) {
      completeResize(activeSession.pointerId, false);
    }
    const handle = event.currentTarget;
    if (typeof handle.setPointerCapture === "function") {
      handle.setPointerCapture(event.pointerId);
    }
    dragSessionRef.current = {
      handle,
      lastWidth: effectiveWidth,
      pointerId: event.pointerId,
      startWidth: effectiveWidth,
      startX: event.clientX,
    };

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || pointerEvent.pointerId !== session.pointerId) {
        return;
      }
      const nextWidth = clampDrawerWidth(
        session.startWidth + session.startX - pointerEvent.clientX,
        drawerViewportWidth,
      );
      session.lastWidth = nextWidth;
      applyDragWidth(nextWidth);
    };

    const handlePointerUp = (pointerEvent: PointerEvent) => {
      completeResize(pointerEvent.pointerId, true);
    };

    const handlePointerCancel = (pointerEvent: PointerEvent) => {
      completeResize(pointerEvent.pointerId, false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    removePointerListenersRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      removePointerListenersRef.current = () => undefined;
    };
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const nextWidth =
      event.key === "ArrowLeft"
        ? effectiveWidth + 16
        : event.key === "ArrowRight"
          ? effectiveWidth - 16
          : event.key === "Home"
            ? 420
            : event.key === "End"
              ? drawerMaximumWidth
              : undefined;
    if (nextWidth === undefined) {
      return;
    }
    event.preventDefault();
    const clampedWidth = clampDrawerWidth(nextWidth, drawerViewportWidth);
    if (clampedWidth !== effectiveWidth) {
      persistPreferences({
        ...normalizedPreferences,
        widthPx: clampedWidth,
      });
    }
  };

  useEffect(
    () => () => {
      removePointerListenersRef.current();
      dragSessionRef.current = undefined;
    },
    [],
  );

  const resizeHandle = (
    <div
      aria-label={t("skillLibrary.drawer.resize")}
      aria-orientation="vertical"
      aria-valuemax={drawerMaximumWidth}
      aria-valuemin={420}
      aria-valuenow={effectiveWidth}
      className="sh-skill-drawer__resize"
      onKeyDown={resizeWithKeyboard}
      onLostPointerCapture={(event) => completeResize(event.pointerId, false)}
      onPointerDown={beginResize}
      role="separator"
      tabIndex={0}
    />
  );
  useEffect(() => {
    setTranslationDraft(undefined);
    setTranslationError(undefined);
    setTranslationLoading(false);
    if (detailQuery.data) {
      setLocalView(detailQuery.data);
      setEditingField(undefined);
      setEditingValue("");
    } else {
      setLocalView(undefined);
    }
  }, [detailQuery.data]);

  const view = localView ?? detailQuery.data;
  const versionsHref = skillId
    ? `${location.pathname.startsWith("/__preview") ? "/__preview/skill-detail" : "/library"}/${skillId}${detailSearch}#${prototypeEnabled ? "versions" : "source"}`
    : undefined;
  const versionsState = libraryReturn ? { libraryReturn } : undefined;

  const beginEdit = (field: "alias" | "note" | "purpose") => {
    if (!view) return;
    setEditingField(field);
    setEditingValue(
      field === "alias"
        ? view.alias ?? ""
        : field === "purpose"
          ? view.purpose ?? ""
          : view.note ?? "",
    );
  };

  const commitEdit = () => {
    if (!editingField || !view) return;
    const value = editingValue.trim();
    const patch: SkillMetadataPatch =
      editingField === "alias"
        ? { alias: value || null }
        : editingField === "purpose"
          ? { purpose: value || null }
          : { note: value || null };
    const persistedView = detailQuery.data;
    setLocalView({
      ...view,
      ...(editingField === "alias"
        ? { alias: value || undefined }
        : editingField === "purpose"
          ? // 抽屉用途字段展示用户独立撰写的用途（QA-008），乐观更新同步 userPurpose。
            { purpose: value, userPurpose: value || undefined }
          : { note: value || undefined }),
    });
    setEditingField(undefined);
    setEditingValue("");
    // QA-007：保存能力未接入或保存失败都必须让用户看到，不能静默吞掉编辑。
    const save = facade.saveSkillMetadata?.bind(facade);
    if (!save) {
      setMetadataSaveFailed(true);
      if (persistedView) setLocalView(persistedView);
      return;
    }
    void save(view.id, patch).then(
      () => {
        setMetadataSaveFailed(false);
        // 失效技能库根键：前缀匹配同时重新读取列表和当前快速视图。
        // DEV-16：详情页的 summary/metadata 缓存一并失效，列表、抽屉、
        // 详情页三处读值同步，不留陈旧投影。
        void queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
        void queryClient.invalidateQueries({ queryKey: skillDetailKeys.metadata(view.id) });
        void queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(view.id) });
        void refreshSnapshot?.();
      },
      () => {
        setMetadataSaveFailed(true);
        if (persistedView) setLocalView(persistedView);
      },
    );
  };

  const translateDescription = () => {
    if (!view || !facade.translateDescription) return;
    setTranslationLoading(true);
    setTranslationError(undefined);
    void facade.translateDescription(view.id).then(
      (result) => {
        setTranslationDraft(result.text);
        setTranslationLoading(false);
      },
      () => {
        setTranslationError(t("skillLibrary.drawer.translation.failed"));
        setTranslationLoading(false);
      },
    );
  };

  const confirmTranslation = () => {
    if (!view || !translationDraft || !facade.saveSkillMetadata) return;
    const draft = translationDraft;
    const persistedView = detailQuery.data;
    void facade.saveSkillMetadata(view.id, { purpose: draft }).then(
      () => {
        setLocalView({ ...view, purpose: draft, userPurpose: draft, translatedDescription: draft });
        setTranslationDraft(undefined);
        setTranslationError(undefined);
        void queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
        void queryClient.invalidateQueries({ queryKey: skillLibraryKeys.quickView(view.id) });
        void queryClient.invalidateQueries({ queryKey: skillDetailKeys.metadata(view.id) });
        void queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(view.id) });
        void refreshSnapshot?.();
      },
      () => {
        if (persistedView) setLocalView(persistedView);
        setTranslationError(t("skillLibrary.drawer.translation.saveFailed"));
      },
    );
  };

  const confirmTagAction = (tags: string[]) => {
    if (!tagAction || !view) return;
    setTagAction(undefined);
    // P1-10：抽屉内标签写经 set_metadata 读改写落地，不走生产未绑定的
    // emitBatchIntent（该路径此前静默失败）。批量添加并入现有标签。
    saveTags([...new Set([...view.tags, ...tags])]);
  };

  const saveTags = (nextTags: string[]) => {
    if (!view) return;
    const persistedView = detailQuery.data;
    setLocalView({ ...view, tags: nextTags });
    const save = facade.saveSkillMetadata?.bind(facade);
    if (!save) {
      setTagsSaveFailed(true);
      if (persistedView) setLocalView(persistedView);
      return;
    }
    void save(view.id, { tags: nextTags }).then(
      () => {
        setTagsSaveFailed(false);
        // 失效技能库根键：列表 tags 列与筛选 facets 随之刷新（同别名保存先例）。
        // DEV-16：详情页 summary/metadata 同步失效，三处投影一致。
        void queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
        void queryClient.invalidateQueries({ queryKey: skillDetailKeys.metadata(view.id) });
        void queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(view.id) });
        void refreshSnapshot?.();
      },
      () => {
        setTagsSaveFailed(true);
        if (persistedView) setLocalView(persistedView);
      },
    );
  };

  const removeTag = (tag: string) => {
    if (!view) return;
    saveTags(view.tags.filter((current) => current !== tag));
  };

  return (
    <Drawer
      description={t("skillLibrary.drawer.description")}
      hideHeader
      leadingAccessory={resizeHandle}
      onOpenChange={onOpenChange}
      open={open}
      panelClassName={`sh-skill-drawer${prototypeEnabled ? " sh-skill-drawer--prototype" : ""}`}
      panelStyle={panelStyle}
      returnFocusRef={returnFocusRef}
      title={view?.name ?? t("skillLibrary.drawer.title")}
    >
      <div
        className="sh-skill-drawer__layout"
        data-drawer-prototype={prototypeEnabled ? "review" : undefined}
        data-preset={normalizedPreferences.preset}
        data-testid="skill-quick-drawer"
        ref={drawerLayoutRef}
        style={panelStyle}
      >
        {prototypeEnabled ? (
        <div className="sh-skill-drawer__chrome">
          <div className="sh-skill-drawer__toolbar">
            {view && skillId ? (
              <Link
                className={`sh-button sh-button--primary sh-button--sm${prototypeEnabled ? " sh-skill-drawer__prototype-details" : ""}`}
                state={libraryReturn ? { libraryReturn } : undefined}
                to={{ pathname: `${location.pathname.startsWith("/__preview") ? "/__preview/skill-detail" : "/library"}/${skillId}`, search: fullDetailsSearch }}
              >
                {t(prototypeEnabled ? "skillLibrary.drawer.prototype.fullDetails" : "skillLibrary.drawer.fullDetails")}
              </Link>
            ) : <span />}
            <div className="sh-skill-drawer__toolbar-end">

              {prototypeEnabled ? (
                <div aria-label={t("skillLibrary.drawer.presets.label")} className="sh-skill-drawer__presets sh-skill-drawer__prototype-presets" role="group">
                  {(() => {
                    const presetOrder: DrawerPreset[] = ["standard", "wide", "near_full"];
                    const currentIndex = presetOrder.indexOf(normalizedPreferences.preset);
                    const nextPreset = presetOrder[(currentIndex + 1) % presetOrder.length];
                    const label = t("skillLibrary.drawer.prototype.cycleWidth", {
                      current: t(PRESET_LABEL_KEYS[normalizedPreferences.preset]),
                      next: t(PRESET_LABEL_KEYS[nextPreset]),
                    });
                    return (
                      <Button
                        aria-label={label}
                        className="sh-skill-drawer__preset-icon-button"
                        data-tooltip={label}
                        onClick={cyclePreset}
                        size="sm"
                        title={label}
                        variant="ghost"
                      >
                        <span
                          aria-hidden="true"
                          className={`sh-skill-drawer__preset-icon sh-skill-drawer__preset-icon--${normalizedPreferences.preset}`}
                        />
                      </Button>
                    );
                  })()}
                </div>
              ) : (
                <div aria-label={t("skillLibrary.drawer.presets.label")} className="sh-skill-drawer__presets" role="group">
                  {(["standard", "wide", "near_full"] as const).map((preset) => (
                    <Button
                      aria-label={t(PRESET_LABEL_KEYS[preset])}
                      aria-pressed={normalizedPreferences.preset === preset}
                      className="sh-skill-drawer__preset-icon-button"
                      key={preset}
                      onClick={() => choosePreset(preset)}
                      size="sm"
                      title={t(PRESET_LABEL_KEYS[preset])}
                      variant={normalizedPreferences.preset === preset ? "secondary" : "ghost"}
                    >
                      <span
                        aria-hidden="true"
                        className={`sh-skill-drawer__preset-icon sh-skill-drawer__preset-icon--${preset}`}
                      />
                    </Button>
                  ))}
                </div>
              )}
              <Button
                aria-label={t("actions.close")}
                className="sh-skill-drawer__close-button"
                onClick={() => onOpenChange(false)}
                size="sm"
                title={t("actions.close")}
                variant="ghost"
              >
                <Icon name="close" size={16} />
              </Button>
            </div>
          </div>
          {view ? (
            <div className={prototypeEnabled ? "sh-skill-drawer__prototype-heading" : undefined}>
              <PinnedDrawerTitle name={view.name} />
              {prototypeEnabled ? (
                <PrototypePrimaryActions drawerPrototype view={view} />
              ) : null}
            </div>
          ) : null}
        </div>

        ) : (
        <div className="sh-skill-drawer__chrome">
          <div className="sh-skill-drawer__title-row">
            {view ? <PinnedDrawerTitle name={view.name} /> : <span />}
            <PrimaryActions onDelete={onDelete} view={view} />
          </div>
          <div className="sh-skill-drawer__toolbar">
            {view && skillId ? (
              <Link
                className="sh-button sh-button--primary sh-button--sm sh-skill-drawer__full-details"
                state={libraryReturn ? { libraryReturn } : undefined}
                to={{ pathname: `${location.pathname.startsWith("/__preview") ? "/__preview/skill-detail" : "/library"}/${skillId}`, search: detailSearch }}
              >
                {t("skillLibrary.drawer.fullDetails")}
              </Link>
            ) : <span />}
            <div className="sh-skill-drawer__toolbar-end">
              <Button
                aria-label={t("skillLibrary.drawer.presets.cycle", {
                  current: t(PRESET_LABEL_KEYS[normalizedPreferences.preset]),
                  next: t(PRESET_LABEL_KEYS[DRAWER_PRESET_CYCLE[(DRAWER_PRESET_CYCLE.indexOf(normalizedPreferences.preset) + 1) % DRAWER_PRESET_CYCLE.length]]),
                })}
                className="sh-skill-drawer__preset-cycle"
                onClick={cyclePreset}
                size="sm"
                title={t("skillLibrary.drawer.presets.cycle", {
                  current: t(PRESET_LABEL_KEYS[normalizedPreferences.preset]),
                  next: t(PRESET_LABEL_KEYS[DRAWER_PRESET_CYCLE[(DRAWER_PRESET_CYCLE.indexOf(normalizedPreferences.preset) + 1) % DRAWER_PRESET_CYCLE.length]]),
                })}
                variant="ghost"
              >
                <span aria-hidden="true" className={`sh-skill-drawer__preset-icon sh-skill-drawer__preset-icon--${normalizedPreferences.preset}`} />
              </Button>
              <Button
                aria-label={t("actions.close")}
                className="sh-skill-drawer__close-button"
                onClick={() => onOpenChange(false)}
                size="sm"
                variant="ghost"
              >
                <Icon name="close" size={16} />
              </Button>
            </div>
          </div>
        </div>

        )}

        <div
          aria-label={t("skillLibrary.drawer.description")}
          className="sh-skill-drawer__scroll"
          data-testid="drawer-modules-scroll"
          role="region"
          tabIndex={0}
        >
          {(preferenceSaveFailed ?? localPreferenceSaveFailed) ? (
            <p className="sh-skill-drawer__alert" role="alert">
              {t("skillLibrary.drawer.preferenceFailure")}
            </p>
          ) : null}
          {metadataSaveFailed ? (
            <p className="sh-skill-drawer__alert" role="alert">
              {t("skillLibrary.drawer.metadataFailure")}
            </p>
          ) : null}
          {tagsSaveFailed ? (
            <p className="sh-skill-drawer__alert" role="alert">
              {t("skillLibrary.drawer.tagsFailure")}
            </p>
          ) : null}

          {!skillId ? (
            <p className="sh-skill-drawer__state" role="status">
              {t("skillLibrary.drawer.detail.empty")}
            </p>
          ) : detailQuery.isPending ? (
            <p className="sh-skill-drawer__state" role="status">
              {t("skillLibrary.drawer.detail.loading")}
            </p>
          ) : detailQuery.isError ? (
            <div className="sh-skill-drawer__state" role="alert">
              <p>{t("skillLibrary.drawer.detail.error")}</p>
              <Button onClick={() => void detailQuery.refetch()} size="sm" variant="secondary">
                {t("actions.retry")}
              </Button>
            </div>
          ) : view ? (
            <div className="sh-skill-drawer__summary-stack">
              {prototypeEnabled ? (
              <PrototypeIdentityRegion
                drawerPrototype
                editingField={editingField}
                editingValue={editingValue}
                onAddTags={() => setTagAction("add_tag")}
                onBeginEdit={beginEdit}
                onChange={setEditingValue}
                onCommit={commitEdit}
                onRemoveTag={removeTag}
                onCancelTranslation={() => {
                  setTranslationDraft(undefined);
                  setTranslationError(undefined);
                }}
                onConfirmTranslation={confirmTranslation}
                onTranslateDescription={facade.translateDescription ? translateDescription : undefined}
                translationDraft={translationDraft}
                translationError={translationError}
                translationLoading={translationLoading}
                view={view}
              />
              ) : (
              <IdentityRegion
                editingField={editingField}
                editingValue={editingValue}
                onAddTags={() => setTagAction("add_tag")}
                facade={facade}
                onTrialChange={(due) => setLocalView((current) => current ? {
                  ...current,
                  lifecycle: due ? "trial" : "active",
                  trialDue: due ?? undefined,
                } : current)}
                onBeginEdit={beginEdit}
                onChange={setEditingValue}
                onCommit={commitEdit}
                onRemoveTag={removeTag}
                onCancelTranslation={() => {
                  setTranslationDraft(undefined);
                  setTranslationError(undefined);
                }}
                onConfirmTranslation={confirmTranslation}
                onTranslateDescription={facade.translateDescription ? translateDescription : undefined}
                translationDraft={translationDraft}
                translationError={translationError}
                translationLoading={translationLoading}
                trialFacade={trialFacade}
                view={view}
              />
              )}
            </div>
          ) : null}

          {view ? (
            prototypeEnabled ? (
            <div className="sh-skill-drawer__modules sh-skill-drawer__prototype-modules">
              <PrototypeRelationsModule drawerPrototype view={view} />
              <PrototypeCollectionsModule />
              {normalizedPreferences.visibleModules.includes("usage_evidence") ? <UsageEvidenceModule view={view} /> : null}
              <PrototypeSubjectLocationModule />
              <PrototypeSecurityChecksModule securityFacade={securityFacade} view={view} />
              <SourceVersionPrototypeModule versionsHref={versionsHref} versionsState={versionsState} view={view} />
            </div>
            ) : (
            <div className="sh-skill-drawer__modules">
          {FIXED_DRAWER_MODULE_ORDER.map((moduleId) => {
                const ModuleRenderer = OPTIONAL_MODULE_RENDERERS[moduleId];
                return (
                  <ModuleRenderer
                    key={moduleId}
                    securityFacade={securityFacade}
                    libraryReturn={libraryReturn}
                    open={open}
                    relationshipFacade={relationshipFacade}
                    versionsHref={versionsHref}
                    versionsState={versionsState}
                    view={view}
                  />
                );
              })}
            </div>
            )
          ) : null}
        </div>

      </div>
      {tagAction ? (
        <BatchTagDialog
          action={tagAction}
          count={1}
          onCancel={() => setTagAction(undefined)}
          onConfirm={confirmTagAction}
        />
      ) : null}
    </Drawer>
  );
}



const PROTOTYPE_ACTION_TITLE_KEYS = {
  dispatch: "skillLibrary.drawer.prototype.actionTitles.dispatch",
  export: "skillLibrary.drawer.prototype.actionTitles.export",
  delete: "skillLibrary.drawer.prototype.actionTitles.delete",
} as const;


const PROTOTYPE_ACTION_IMPACT_KEYS = {
  dispatch: "skillLibrary.drawer.prototype.actionImpacts.dispatch",
  export: "skillLibrary.drawer.prototype.actionImpacts.export",
  delete: "skillLibrary.drawer.prototype.actionImpacts.delete",
} as const;


const MAX_VISIBLE_PROJECTS = 3;

const MAX_PROTOTYPE_VISIBLE_TAGS = 4;


function PrototypeTranslationIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="17" viewBox="0 0 24 24" width="17">
      <path d="m12 2.75 1.45 5.8 5.8 1.45-5.8 1.45-1.45 5.8-1.45-5.8-5.8-1.45 5.8-1.45 1.45-5.8Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.65" />
      <path d="m19.25 15.25.72 2.78 2.78.72-2.78.72-.72 2.78-.72-2.78-2.78-.72 2.78-.72.72-2.78Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.35" />
    </svg>
  );
}


function PrototypePlusIcon() {
  return <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" /></svg>;
}


function PrototypeCopyIcon() {
  return <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16"><rect height="13" rx="2" stroke="currentColor" strokeWidth="1.6" width="13" x="8" y="8" /><path d="M16 5H6a2 2 0 0 0-2 2v10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" /></svg>;
}


function PrototypeCalendarIcon() {
  return <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16"><rect height="15" rx="2" stroke="currentColor" strokeWidth="1.6" width="17" x="3.5" y="5.5" /><path d="M7.5 3.5v4M16.5 3.5v4M3.5 10h17M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" /></svg>;
}


function useBoundedPrototypePopover() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusOnClose = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (contentRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      restoreFocusOnClose.current = false;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);
  const close = (restoreFocus = false) => {
    restoreFocusOnClose.current = restoreFocus;
    setOpen(false);
  };
  const onOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) restoreFocusOnClose.current = true;
    setOpen(nextOpen);
  };
  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    if (restoreFocusOnClose.current) triggerRef.current?.focus();
    restoreFocusOnClose.current = false;
  };
  return {
    close,
    contentRef,
    onCloseAutoFocus,
    onOpenChange,
    open,
    position,
    setPosition,
    setOpen,
    triggerRef,
  };
}


interface PrototypePopoverProps {
  ariaLabel: string;
  children: ReactNode;
  className: string;
  contentRef: MutableRefObject<HTMLDivElement | null>;
  onCloseAutoFocus: (event: Event) => void;
  onOpenChange: (open: boolean) => void;
  id?: string;
  open: boolean;
  position: { left: number; top: number };
  setPosition: (position: { left: number; top: number }) => void;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
}


function PrototypePopover({
  ariaLabel,
  children,
  className,
  contentRef,
  id,
  onCloseAutoFocus,
  onOpenChange,
  open,
  position,
  setPosition,
  triggerRef,
}: PrototypePopoverProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const setContentElement = (element: HTMLDivElement | null) => {
    contentRef.current = element;
    const trigger = triggerRef.current;
    if (!element || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    const panel = element.getBoundingClientRect();
    setPosition({
      left: Math.max(12, Math.min(anchor.left, window.innerWidth - panel.width - 12)),
      top: Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - panel.height - 12)),
    });
  };
  return (
    <DialogPrimitive.Root modal={false} onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={`${titleId}-description`}
          aria-labelledby={titleId}
          className={className}
          id={id}
          onCloseAutoFocus={onCloseAutoFocus}
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          ref={setContentElement}
          style={{ left: position.left, top: position.top }}
          tabIndex={-1}
        >
          <DialogPrimitive.Title className="sh-visually-hidden" id={titleId}>{ariaLabel}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sh-visually-hidden" id={`${titleId}-description`}>
            {t("skillLibrary.drawer.prototype.popoverDescription")}
          </DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}


function PrototypeLifecycleControl() {
  const { t } = useTranslation();
  const reviewPopover = useBoundedPrototypePopover();
  const [isTrial, setIsTrial] = useState(true);
  const [reviewDate, setReviewDate] = useState("2026-10-17");
  const [draftDate, setDraftDate] = useState(reviewDate);
  const openDateEditor = (event: ReactMouseEvent<HTMLButtonElement>) => {
    reviewPopover.triggerRef.current = event.currentTarget;
    setDraftDate(reviewDate);
    reviewPopover.setOpen(true);
  };
  return (
    <div className="sh-skill-drawer__prototype-lifecycle">
      <span className={`sh-skill-drawer__prototype-lifecycle-state${isTrial ? " is-trial" : ""}`}>
        {isTrial ? t("skillLibrary.drawer.prototype.trial") : t("skillLibrary.drawer.prototype.regular")}
      </span>
      {isTrial ? <time dateTime={reviewDate}>{reviewDate}</time> : null}
      {isTrial ? (
        <Button aria-expanded={reviewPopover.open} aria-haspopup="dialog" aria-label={t("skillLibrary.drawer.prototype.adjustReviewDate")} className="sh-skill-drawer__prototype-calendar" data-tooltip={t("skillLibrary.drawer.prototype.adjustReviewDate")} onClick={openDateEditor} size="sm" title={t("skillLibrary.drawer.prototype.adjustReviewDate")} variant="ghost">
          <PrototypeCalendarIcon />
        </Button>
      ) : (
        <Button aria-expanded={reviewPopover.open} aria-haspopup="dialog" aria-label={t("skillLibrary.drawer.prototype.setTrial")} className="sh-skill-drawer__prototype-calendar" data-tooltip={t("skillLibrary.drawer.prototype.setTrial")} onClick={openDateEditor} size="sm" title={t("skillLibrary.drawer.prototype.setTrial")} variant="ghost">
          <PrototypeCalendarIcon />
        </Button>
      )}
      {isTrial ? (
        <Button className="sh-skill-drawer__prototype-convert-regular" onClick={() => setIsTrial(false)} size="sm" variant="secondary">
          {t("skillLibrary.drawer.prototype.convertRegular")}
        </Button>
      ) : null}
      {reviewPopover.open ? (
        <PrototypePopover
          ariaLabel={t("skillLibrary.drawer.prototype.reviewDateDialog")}
          className="sh-skill-drawer__prototype-popover sh-skill-drawer__prototype-lifecycle-popover"
          contentRef={reviewPopover.contentRef}
          onCloseAutoFocus={reviewPopover.onCloseAutoFocus}
          onOpenChange={reviewPopover.onOpenChange}
          open={reviewPopover.open}
          position={reviewPopover.position}
          setPosition={reviewPopover.setPosition}
          triggerRef={reviewPopover.triggerRef}
        >
          <label>
            {t("skillLibrary.drawer.prototype.reviewDate")}
            <input aria-label={t("skillLibrary.drawer.prototype.reviewDate")} onChange={(event) => setDraftDate(event.currentTarget.value)} type="date" value={draftDate} />
          </label>
          <div className="sh-skill-drawer__prototype-popover-actions">
            <Button onClick={() => { setReviewDate(draftDate); setIsTrial(true); reviewPopover.close(true); }} size="sm">
              {t("skillLibrary.drawer.prototype.saveDatePreview")}
            </Button>
            <Button onClick={() => reviewPopover.close(true)} size="sm" variant="ghost">
              {t("actions.cancel")}
            </Button>
          </div>
        </PrototypePopover>
      ) : null}
    </div>
  );
}


const PROTOTYPE_COLLECTIONS = ["文档工具", "PDF 工作流", "研发工具"];


function PrototypeCollectionsModule() {
  const { t } = useTranslation();
  const collectionPopover = useBoundedPrototypePopover();
  const [selected, setSelected] = useState<string[]>(PROTOTYPE_COLLECTIONS.slice(0, 2));
  const [draft, setDraft] = useState<string[]>(selected);
  const collectionLabelId = useId();
  const openEditor = (event: ReactMouseEvent<HTMLButtonElement>, next = selected) => {
    collectionPopover.triggerRef.current = event.currentTarget;
    setDraft([...next]);
    collectionPopover.setOpen(true);
  };
  const toggleCollection = (collection: string) => {
    setDraft((current) => current.includes(collection)
      ? current.filter((item) => item !== collection)
      : [...current, collection]);
  };
  return (
    <ModuleCard title={t("skillLibrary.drawer.prototype.collectionsTitle")}>
      <div className="sh-skill-drawer__prototype-collections">
        <div aria-label={t("skillLibrary.drawer.prototype.collectionsTitle")} className="sh-skill-drawer__prototype-collection-chips" role="list">
          {selected.map((collection) => (
            <span className="sh-skill-drawer__prototype-collection-chip" key={collection} role="listitem">
              {collection}
              <Button aria-label={t("skillLibrary.drawer.prototype.removeCollection", { name: collection })} onClick={(event) => openEditor(event, selected.filter((item) => item !== collection))} size="sm" variant="ghost">
                <Icon name="close" size={14} />
              </Button>
            </span>
          ))}
        </div>
        <Button aria-label={t("skillLibrary.drawer.prototype.editCollections")} className="sh-skill-drawer__prototype-collection-add" onClick={(event) => openEditor(event)} size="sm" variant="ghost">
          <PrototypePlusIcon />
        </Button>
      </div>
      {collectionPopover.open ? (
        <PrototypePopover
          ariaLabel={t("skillLibrary.drawer.prototype.collectionsDialog")}
          className="sh-skill-drawer__prototype-popover sh-skill-drawer__prototype-collections-popover"
          contentRef={collectionPopover.contentRef}
          onCloseAutoFocus={collectionPopover.onCloseAutoFocus}
          onOpenChange={collectionPopover.onOpenChange}
          open={collectionPopover.open}
          position={collectionPopover.position}
          setPosition={collectionPopover.setPosition}
          triggerRef={collectionPopover.triggerRef}
        >
          <strong id={collectionLabelId}>{t("skillLibrary.drawer.prototype.collectionsDialog")}</strong>
          <fieldset>
            <legend>{t("skillLibrary.drawer.prototype.collectionsHelp")}</legend>
            {PROTOTYPE_COLLECTIONS.map((collection) => (
              <label key={collection}>
                <input checked={draft.includes(collection)} onChange={() => toggleCollection(collection)} type="checkbox" />
                <span>{collection}</span>
              </label>
            ))}
          </fieldset>
          <div className="sh-skill-drawer__prototype-popover-actions">
            <Button onClick={() => { setSelected(draft); collectionPopover.close(true); }} size="sm">
              {t("skillLibrary.drawer.prototype.saveCollections")}
            </Button>
            <Button onClick={() => collectionPopover.close(true)} size="sm" variant="ghost">
              {t("actions.cancel")}
            </Button>
          </div>
        </PrototypePopover>
      ) : null}
    </ModuleCard>
  );
}


const PROTOTYPE_SKILL_PATH = "C:\\preview\\SkillHub\\skills\\pdf-reader";


function PrototypeSubjectLocationModule() {
  const { t } = useTranslation();
  const locationPopover = useBoundedPrototypePopover();
  const [copyStatus, setCopyStatus] = useState<"copied" | "unavailable" | "">("");
  const openLocationPreview = (event: ReactMouseEvent<HTMLButtonElement>) => {
    locationPopover.triggerRef.current = event.currentTarget;
    locationPopover.setOpen(true);
  };
  const copySamplePath = async () => {
    try {
      await navigator.clipboard.writeText(PROTOTYPE_SKILL_PATH);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("unavailable");
    }
  };
  return (
    <ModuleCard title={t("skillLibrary.drawer.prototype.subjectLocationTitle")}>
      <div className="sh-skill-drawer__prototype-location">
        <code title={PROTOTYPE_SKILL_PATH}>{PROTOTYPE_SKILL_PATH}</code>
        <span>{t("skillLibrary.drawer.prototype.sampleOnly")}</span>
        <div>
          <Button aria-label={t("skillLibrary.drawer.prototype.openSampleLocation")} onClick={openLocationPreview} size="sm" variant="ghost">
            <Icon name="open-external" size={16} />
          </Button>
          <Button aria-label={t("skillLibrary.drawer.prototype.copySamplePath")} onClick={() => void copySamplePath()} size="sm" variant="ghost">
            <PrototypeCopyIcon />
          </Button>
        </div>
        {copyStatus ? (
          <span
            aria-live="polite"
            className={`sh-skill-drawer__prototype-copy-status${copyStatus === "unavailable" ? " is-error" : ""}`}
            role="status"
          >
            {t(copyStatus === "copied"
              ? "skillLibrary.drawer.prototype.samplePathCopied"
              : "skillLibrary.drawer.prototype.samplePathCopyUnavailable")}
          </span>
        ) : null}
      </div>
      {locationPopover.open ? (
        <PrototypePopover
          ariaLabel={t("skillLibrary.drawer.prototype.subjectLocationDialog")}
          className="sh-skill-drawer__prototype-popover sh-skill-drawer__prototype-location-popover"
          contentRef={locationPopover.contentRef}
          onCloseAutoFocus={locationPopover.onCloseAutoFocus}
          onOpenChange={locationPopover.onOpenChange}
          open={locationPopover.open}
          position={locationPopover.position}
          setPosition={locationPopover.setPosition}
          triggerRef={locationPopover.triggerRef}
        >
          <strong>{t("skillLibrary.drawer.prototype.subjectLocationDialog")}</strong>
          <code title={PROTOTYPE_SKILL_PATH}>{PROTOTYPE_SKILL_PATH}</code>
          <p>{t("skillLibrary.drawer.prototype.noFilesystemOpen")}</p>
          <Button onClick={() => locationPopover.close(true)} size="sm" variant="ghost">
            {t("skillLibrary.drawer.prototype.closeLocationPreview")}
          </Button>
        </PrototypePopover>
      ) : null}
    </ModuleCard>
  );
}


function PrototypeRelationsModule({ drawerPrototype = false, view }: ModuleProps & { drawerPrototype?: boolean }) {
  const { t } = useTranslation();
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const relationPopover = useBoundedPrototypePopover();
  const [selectedTarget, setSelectedTarget] = useState<{ name: string; type: "agent" | "project"; managed: boolean; path?: string }>();
  const [relationPreviewSection, setRelationPreviewSection] = useState<"summary" | "target" | "governance">("summary");
  const agentDeployments = (view.agentDeployments ?? []).map((agent) => {
    if (!drawerPrototype) return agent;
    if (agent.id === "codex") {
      return { ...agent, agentId: "codex-cli", brand: "openai", name: "Codex CLI" };
    }
    if (agent.id === "claude") {
      return { ...agent, agentId: "claude-code", brand: "anthropic", name: "Claude Code" };
    }
    return agent;
  });
  const projects = view.projectDeployments ?? [];
  const visibleProjects = drawerPrototype
    ? projects
    : projectsExpanded ? projects : projects.slice(0, MAX_VISIBLE_PROJECTS);
  const hiddenProjectCount = Math.max(0, projects.length - MAX_VISIBLE_PROJECTS);
  const openRelationPreview = (event: ReactMouseEvent<HTMLButtonElement>, target: { name: string; type: "agent" | "project"; managed: boolean; path?: string }) => {
    relationPopover.triggerRef.current = event.currentTarget;
    setSelectedTarget(target);
    setRelationPreviewSection("summary");
    relationPopover.setOpen(true);
  };

  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.relations)}>
      <div className="sh-skill-drawer__relations-grid">
        <div className="sh-skill-drawer__relation-group">
          <div className="sh-skill-drawer__relation-heading">
            <strong>{t("skillLibrary.drawer.values.agents")}</strong>
            <span className="sh-skill-drawer__relation-count">{view.agentDeploymentCount}</span>
          </div>
          {agentDeployments.length > 0 ? (
            drawerPrototype ? (
              <div
                aria-label={t("skillLibrary.table.agentDeploymentSummary", {
                  count: view.agentDeploymentCount,
                })}
                className="sh-skill-drawer__prototype-agent-cards"
                data-testid="prototype-agent-scroll"
                role="region"
                tabIndex={0}
              >
                {agentDeployments.map((agent, index) => (
                  <button
                    aria-label={t("skillLibrary.drawer.prototype.openRelationContext", { target: agent.name })}
                    className="sh-skill-drawer__prototype-agent-card"
                    key={agent.id}
                    onClick={(event) => openRelationPreview(event, { name: agent.name, type: "agent", managed: index === 0 })}
                    title={agent.name}
                    type="button"
                  >
                    <AgentPresentation
                      agentId={agent.agentId ?? agent.id}
                      brand={agent.brand}
                      density="full"
                      instance={agent.name}
                      sharedDirectory={agent.sharedDirectory}
                    />
                    <span className={`sh-skill-drawer__prototype-relation-state${index === 0 ? " is-managed" : " is-pending"}`}>
                      {t(index === 0 ? "skillLibrary.drawer.prototype.sampleManaged" : "skillLibrary.drawer.prototype.samplePending")}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <AgentDeploymentIcons
                agents={agentDeployments}
                ariaLabel={t("skillLibrary.table.agentDeploymentSummary", {
                  count: view.agentDeploymentCount,
                })}
              />
            )
          ) : (
            <EmptyValue />
          )}
        </div>
        <div className="sh-skill-drawer__relation-group">
          <div className="sh-skill-drawer__relation-heading">
            <strong>{t("skillLibrary.drawer.values.projects")}</strong>
            <span className="sh-skill-drawer__relation-count">{view.projectDeploymentCount}</span>
          </div>
          {projects.length > 0 ? (
            drawerPrototype ? (
              <div
                aria-label={t("skillLibrary.drawer.prototype.projectTargets", {
                  count: view.projectDeploymentCount,
                })}
                className="sh-skill-drawer__prototype-project-scroll"
                data-testid="prototype-project-scroll"
                role="region"
                tabIndex={0}
              >
                <ul className="sh-skill-drawer__project-list">
                  {projects.map((project, index) => (
                    <li key={project.id}>
                      <button
                        aria-label={t("skillLibrary.drawer.prototype.openRelationContext", { target: project.name })}
                        className="sh-skill-drawer__prototype-project-card"
                        onClick={(event) => openRelationPreview(event, { name: project.name, type: "project", managed: index === 0, path: displayPath(project.path) })}
                        type="button"
                      >
                        <strong title={project.name}>{project.name}</strong>
                        <code title={displayPath(project.path)}>{displayPath(project.path)}</code>
                        <span className={`sh-skill-drawer__prototype-relation-state${index === 0 ? " is-managed" : " is-pending"}`}>
                          {t(index === 0 ? "skillLibrary.drawer.prototype.sampleManaged" : "skillLibrary.drawer.prototype.samplePending")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <>
                <ul className="sh-skill-drawer__project-list">
                  {visibleProjects.map((project) => (
                    <li key={project.id}>
                      <strong title={project.name}>{project.name}</strong>
                      <code title={displayPath(project.path)}>{displayPath(project.path)}</code>
                    </li>
                  ))}
                </ul>
                {hiddenProjectCount > 0 ? (
                  <button
                    aria-expanded={projectsExpanded}
                    className="sh-skill-drawer__project-toggle"
                    onClick={() => setProjectsExpanded((current) => !current)}
                    type="button"
                  >
                    {projectsExpanded
                      ? t("skillLibrary.drawer.relations.showFewerProjects")
                      : t("skillLibrary.drawer.relations.showMoreProjects", {
                          count: hiddenProjectCount,
                        })}
                  </button>
                ) : null}
              </>
            )
          ) : (
            <EmptyValue />
          )}
        </div>
      </div>
      {drawerPrototype && relationPopover.open && selectedTarget ? (
        <PrototypePopover
          ariaLabel={t("skillLibrary.drawer.prototype.relationContextTitle", { target: selectedTarget.name })}
          className="sh-skill-drawer__prototype-popover sh-skill-drawer__prototype-relation-popover"
          contentRef={relationPopover.contentRef}
          onCloseAutoFocus={relationPopover.onCloseAutoFocus}
          onOpenChange={relationPopover.onOpenChange}
          open={relationPopover.open}
          position={relationPopover.position}
          setPosition={relationPopover.setPosition}
          triggerRef={relationPopover.triggerRef}
        >
          <div className="sh-skill-drawer__prototype-popover-heading">
            <strong>
              {relationPreviewSection === "governance"
                ? t("skillLibrary.drawer.prototype.relationGovernanceSample")
                : relationPreviewSection === "target"
                  ? t("skillLibrary.drawer.prototype.relationTargetSample")
                  : t("skillLibrary.drawer.prototype.relationContextTitle", { target: selectedTarget.name })}
            </strong>
            <Button aria-label={t("skillLibrary.drawer.prototype.closeRelationPreview")} onClick={() => relationPopover.close(true)} size="sm" variant="ghost">
              <Icon name="close" size={16} />
            </Button>
          </div>
          {relationPreviewSection === "summary" ? (
            <>
              <p><span>{t(selectedTarget.type === "agent" ? "skillLibrary.drawer.values.agents" : "skillLibrary.drawer.values.projects")}</span><strong>{selectedTarget.name}</strong></p>
              <p><span>{t("skillLibrary.drawer.prototype.relationshipState")}</span><strong>{t(selectedTarget.managed ? "skillLibrary.drawer.prototype.sampleManaged" : "skillLibrary.drawer.prototype.samplePending")}</strong></p>
              <p>{t(selectedTarget.managed ? "skillLibrary.drawer.prototype.sampleManagedReason" : "skillLibrary.drawer.prototype.samplePendingReason")}</p>
              <div className="sh-skill-drawer__prototype-popover-actions">
                <Button onClick={() => setRelationPreviewSection("target")} size="sm" variant="secondary">
                  {t("skillLibrary.drawer.prototype.openTargetSample", { type: selectedTarget.type === "agent" ? t("skillLibrary.drawer.values.agents") : t("skillLibrary.drawer.values.projects") })}
                </Button>
                <Button onClick={() => setRelationPreviewSection("governance")} size="sm" variant="ghost">
                  {t("skillLibrary.drawer.prototype.openGovernanceSample")}
                </Button>
              </div>
            </>
          ) : relationPreviewSection === "target" ? (
            <>
              <p>{t("skillLibrary.drawer.prototype.targetContextSample", { name: selectedTarget.name, skill: view.name })}</p>
              {selectedTarget.path ? <code title={selectedTarget.path}>{selectedTarget.path}</code> : null}
              <Button onClick={() => setRelationPreviewSection("summary")} size="sm" variant="ghost">{t("skillLibrary.drawer.prototype.backToRelationSummary")}</Button>
            </>
          ) : (
            <>
              <p>{t("skillLibrary.drawer.prototype.governanceContextSample", { skill: view.name, target: selectedTarget.name })}</p>
              <p>{t(selectedTarget.managed ? "skillLibrary.drawer.prototype.sampleManagedReason" : "skillLibrary.drawer.prototype.samplePendingReason")}</p>
              <Button onClick={() => setRelationPreviewSection("summary")} size="sm" variant="ghost">{t("skillLibrary.drawer.prototype.backToRelationSummary")}</Button>
            </>
          )}
        </PrototypePopover>
      ) : null}
    </ModuleCard>
  );
}


function PrototypeSecurityRiskIcon({ description, label, title }: { description: string; label: string; title: string }) {
  return (
    <span aria-description={description} aria-label={label} className="sh-skill-drawer__prototype-security-icon sh-skill-drawer__prototype-security-icon--risk" role="img" tabIndex={0} title={title}>
      <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
        <path d="M12 2.5 20 5v6.1c0 5.1-3.4 8.7-8 10.4-4.6-1.7-8-5.3-8-10.4V5l8-2.5Z" fill="var(--ui-warning-background)" stroke="var(--ui-warning-foreground)" strokeLinejoin="round" strokeWidth="1.2" />
        <path d="M12 7.3v6.1" stroke="var(--ui-danger-foreground)" strokeLinecap="round" strokeWidth="2.5" />
        <circle cx="12" cy="16.7" r="1.3" fill="var(--ui-danger-foreground)" />
      </svg>
    </span>
  );
}


function PrototypeSecurityChecksModule({ securityFacade, view }: ModuleRendererProps) {
  const { t } = useTranslation();
  const [runningKinds, setRunningKinds] = useState<Set<SecurityCheckKind>>(() => new Set());
  const [runErrors, setRunErrors] = useState<Partial<Record<SecurityCheckKind, boolean>>>({});
  const versionId = view.currentVersionId;
  const resultQuery = useQuery({
    enabled: Boolean(versionId),
    queryKey: ["skill-drawer-prototype-security", view.id, versionId],
    queryFn: async () => {
      if (!versionId) return { checks: [], findings: [] };
      const [checks, findings] = await Promise.all([
        securityFacade.getChecks(view.id, versionId),
        securityFacade.listFindings(view.id, versionId),
      ]);
      return { checks, findings };
    },
  });
  const executeCheck = async (kind: SecurityCheckKind) => {
    const run = kind === "basic" ? securityFacade.runBasicCheck : securityFacade.runLlmCheck;
    if (!versionId || !run || runningKinds.has(kind)) return;
    setRunErrors((current) => ({ ...current, [kind]: false }));
    setRunningKinds((current) => new Set(current).add(kind));
    try {
      if (kind === "basic") await securityFacade.runBasicCheck?.(view.id, versionId);
      else await securityFacade.runLlmCheck?.(view.id, versionId);
      await resultQuery.refetch();
    } catch {
      setRunErrors((current) => ({ ...current, [kind]: true }));
    } finally {
      setRunningKinds((current) => {
        const next = new Set(current);
        next.delete(kind);
        return next;
      });
    }
  };
  const checks = resultQuery.data?.checks ?? [];
  const findings = resultQuery.data?.findings ?? [];
  const labels: Record<SecurityCheckKind, string> = {
    basic: t("skillLibrary.drawer.prototype.basicCheck"),
    llm: t("skillLibrary.drawer.prototype.aiCheck"),
  };
  const renderResult = (kind: SecurityCheckKind) => {
    const check: SecurityCheck | undefined = checks.find((item) => item.kind === kind);
    const currentFindings: SecurityFinding[] = findings.filter((item) => item.kind === kind);
    const count = Math.max(check?.findingCount ?? 0, currentFindings.length);
    const actionable = Math.max(check?.actionableCount ?? 0, currentFindings.filter((item) => item.disposition === "actionable").length);
    const running = runningKinds.has(kind);
    const failed = check?.state === "failed" || runErrors[kind] === true || resultQuery.isError;
    const hasRisk = count > 0;
    const clean = check?.state === "passed" && !hasRisk;
    const stateText = !versionId
      ? t("skillLibrary.drawer.prototype.securityNoVersion")
      : resultQuery.isPending
      ? t("skillLibrary.drawer.prototype.securityLoading")
      : running
        ? t("skillLibrary.drawer.prototype.securityRunning")
        : failed
          ? t("skillLibrary.drawer.prototype.securityFailed")
          : hasRisk
            ? t("skillLibrary.drawer.prototype.securityFindings", { count, actionable })
            : clean
              ? t("skillLibrary.drawer.prototype.securityClean")
              : t("skillLibrary.drawer.prototype.securityNotRun");
    const compactText = !versionId
      ? t("skillLibrary.drawer.prototype.securityNoVersion")
      : resultQuery.isPending
      ? t("skillLibrary.drawer.prototype.securityLoading")
      : running
        ? t("skillLibrary.drawer.prototype.securityRunning")
        : failed
          ? t("skillLibrary.drawer.prototype.securityFailed")
          : hasRisk
            ? t("skillLibrary.drawer.prototype.securityCompactFindings", { count, actionable })
            : clean
              ? t("skillLibrary.drawer.prototype.securityClean")
              : t("skillLibrary.drawer.prototype.securityNotRun");
    const checkedAt = check?.checkedAt ? new Date(check.checkedAt).toLocaleString() : t("skillLibrary.drawer.prototype.securityTimeUnavailable");
    const longDescription = t("skillLibrary.drawer.prototype.securityTooltip", {
      check: labels[kind],
      result: stateText,
      version: view.currentVersion,
      time: checkedAt,
    });
    const accessibleLabel = failed
      ? t("skillLibrary.drawer.prototype.securityAccessibleFailed", { check: labels[kind] })
      : hasRisk
        ? t("skillLibrary.drawer.prototype.securityAccessibleRisk", { check: labels[kind], count, actionable })
        : clean
          ? t("skillLibrary.drawer.prototype.securityAccessibleClean", { check: labels[kind] })
          : t("skillLibrary.drawer.prototype.securityAccessibleUnknown", { check: labels[kind], result: stateText });

    return (
      <div className="sh-skill-drawer__prototype-security-result" key={kind}>
        <div className="sh-skill-drawer__prototype-security-summary">
          {failed ? (
            <span aria-description={longDescription} aria-label={accessibleLabel} className="sh-skill-drawer__prototype-security-icon sh-skill-drawer__prototype-security-icon--failed" role="img" tabIndex={0} title={longDescription}>
              <Icon name="failure" size={20} />
            </span>
          ) : hasRisk ? (
            <PrototypeSecurityRiskIcon description={longDescription} label={accessibleLabel} title={longDescription} />
          ) : clean ? (
            <span aria-description={longDescription} aria-label={accessibleLabel} className="sh-skill-drawer__prototype-security-icon sh-skill-drawer__prototype-security-icon--clean" role="img" tabIndex={0} title={longDescription}>
              <Icon name="success" size={20} />
            </span>
          ) : (
            <span aria-description={longDescription} aria-label={accessibleLabel} className="sh-skill-drawer__prototype-security-icon" role="img" tabIndex={0} title={longDescription}>
              <Icon name="info" size={20} />
            </span>
          )}
          <span className="sh-skill-drawer__prototype-security-label">{labels[kind]}</span>
          <strong>{compactText}</strong>
        </div>
        {currentFindings[0] ? <p className="sh-skill-drawer__prototype-risk-message" title={currentFindings[0].message}>{currentFindings[0].message}</p> : null}
        {currentFindings.length > 0 ? (
          <details className="sh-skill-drawer__prototype-findings-disclosure">
            <summary>{t("skillLibrary.drawer.prototype.allFindings", { count: currentFindings.length })}</summary>
            <ul aria-label={t("skillLibrary.drawer.prototype.securityFindingsLabel")} className="sh-skill-drawer__prototype-findings">
              {currentFindings.map((finding) => (
                <li key={finding.id}>
                  <span>{finding.message}</span>
                  {finding.file ? <small>{finding.file}{finding.line ? ` · ${finding.line}` : ""}</small> : null}
                  <small>{finding.disposition === "actionable" ? t("skillLibrary.drawer.prototype.securityNeedsAttention") : t("skillLibrary.drawer.prototype.securityDispositionRecorded")}</small>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {failed ? <p className="sh-skill-drawer__prototype-security-error" role="status">{t("skillLibrary.drawer.prototype.securityFailureDetail")}</p> : null}
      </div>
    );
  };
  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.security_checks)}>
      <p className="sh-skill-drawer__prototype-security-scope">{t("skillLibrary.drawer.prototype.securityLocalScope")}</p>
      <section aria-label={t(MODULE_LABEL_KEYS.risk_summary)} className="sh-skill-drawer__prototype-risk-summary">
        <strong>{t(MODULE_LABEL_KEYS.risk_summary)}</strong>
        <span>{t("skillLibrary.drawer.risk.high", { count: view.highRiskCount })}</span>
        <span>{t("skillLibrary.drawer.risk.pending", { count: view.pendingCount })}</span>
      </section>
      <div className="sh-skill-drawer__prototype-security-results">
        {renderResult("basic")}
        {renderResult("llm")}
      </div>
      <div className="sh-skill-drawer__prototype-security-actions">
        <Button disabled={!versionId || !securityFacade.runBasicCheck || runningKinds.has("basic")} loading={runningKinds.has("basic")} onClick={() => void executeCheck("basic")} size="sm" variant="secondary">
          {t("skillLibrary.drawer.prototype.recheck")}
        </Button>
        <Button disabled={!versionId || !securityFacade.runLlmCheck || runningKinds.has("llm")} loading={runningKinds.has("llm")} onClick={() => void executeCheck("llm")} size="sm" variant="secondary">
          {t("skillLibrary.drawer.prototype.aiCheck")}
        </Button>
      </div>
    </ModuleCard>
  );
}


function SourceVersionPrototypeModule({ versionsHref, versionsState, view }: ModuleProps) {
  const { t } = useTranslation();
  return (
    <ModuleCard title={t("skillLibrary.drawer.prototype.sourceVersionTitle")}>
      <dl className="sh-skill-drawer__prototype-source-facts">
        <div>
          <dt>{t("skillLibrary.drawer.prototype.importReceipt")}</dt>
          <dd>{t("skillLibrary.drawer.prototype.importReceiptSample")}</dd>
        </div>
        <div>
          <dt>{t("skillLibrary.filters.version")}</dt>
          <dd>{view.currentVersion}</dd>
        </div>
        <div>
          <dt>{t("skillLibrary.drawer.values.license")}</dt>
          <dd>{view.license ?? <EmptyValue />}</dd>
        </div>
        <div>
          <dt>{t("skillLibrary.drawer.prototype.networkUpdateSource")}</dt>
          <dd title={t("skillLibrary.drawer.prototype.networkUpdateSourceSample")}>{t("skillLibrary.drawer.prototype.networkUpdateSourceSample")}</dd>
        </div>
      </dl>
      <p className="sh-skill-drawer__prototype-derived-source">
        {t("skillLibrary.drawer.prototype.derivedFromSample", { sourceSkill: "PDF Toolkit" })}
      </p>
      {view.upgradeAvailable ? (
        <div className="sh-skill-drawer__version-update sh-skill-drawer__prototype-update">
          <span aria-hidden="true" className="sh-skill-drawer__prototype-update-mark" />
          <p>{t("skillLibrary.drawer.prototype.updateAvailable")}</p>
          {versionsHref ? (
            <Link
              className="sh-button sh-button--secondary sh-button--sm"
              state={versionsState}
              to={versionsHref}
            >
              {t("skillLibrary.drawer.viewUpdate")}
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="sh-skill-drawer__version-update sh-skill-drawer__prototype-update">
          <span aria-hidden="true" className="sh-skill-drawer__prototype-update-mark" />
          <p className="sh-skill-drawer__secondary">{t("skillLibrary.drawer.values.upToDate")}</p>
          {versionsHref ? <Link className="sh-button sh-button--secondary sh-button--sm" state={versionsState} to={versionsHref}>{t("skillLibrary.drawer.viewUpdate")}</Link> : null}
        </div>
      )}
    </ModuleCard>
  );
}


interface PrototypeIdentityRegionProps extends ModuleProps {
  drawerPrototype?: boolean;
  purposeOverride?: string;
  editingField?: "alias" | "note" | "purpose";
  editingValue: string;
  onAddTags: () => void;
  onBeginEdit: (field: "alias" | "note" | "purpose") => void;
  onChange: (value: string) => void;
  onCommit: () => void;
  onRemoveTag: (tag: string) => void;
  onTranslateDescription?: () => void;
  onConfirmTranslation?: () => void;
  onUseExistingTranslation?: (value: string) => void;
  onCancelTranslation?: () => void;
  translationDraft?: string;
  translationError?: string;
  translationLoading?: boolean;
}


function PrototypeIdentityRegion({
  drawerPrototype = false,
  editingField,
  editingValue,
  onAddTags,
  onBeginEdit,
  onChange,
  onCommit,
  onRemoveTag,
  onCancelTranslation,
  onConfirmTranslation,
  onUseExistingTranslation,
  onTranslateDescription,
  purposeOverride,
  translationDraft,
  translationError,
  translationLoading = false,
  view,
}: PrototypeIdentityRegionProps) {
  const { t } = useTranslation();
  const [prototypeTranslation, setPrototypeTranslation] = useState(view.translatedDescription ?? "");
  const [translationEditing, setTranslationEditing] = useState(false);
  const [translationEditDraft, setTranslationEditDraft] = useState(view.translatedDescription ?? "");
  useEffect(() => {
    setPrototypeTranslation(view.translatedDescription ?? "");
    setTranslationEditDraft(view.translatedDescription ?? "");
    setTranslationEditing(false);
  }, [view.id, view.translatedDescription]);
  const tagPopover = useBoundedPrototypePopover();
  const tagPopoverId = useId();
  const toggleTagPopover = (event: ReactMouseEvent<HTMLButtonElement>) => {
    tagPopover.triggerRef.current = event.currentTarget;
    if (tagPopover.open) tagPopover.close(true);
    else tagPopover.setOpen(true);
  };
  const displayedTags = drawerPrototype ? view.tags.slice(0, MAX_PROTOTYPE_VISIBLE_TAGS) : view.tags;
  const hiddenTagCount = Math.max(0, view.tags.length - displayedTags.length);
  return (
    <section className="sh-skill-drawer__identity sh-skill-drawer__overview">
      <div className="sh-skill-drawer__identity-heading">
        {drawerPrototype ? <h3 className="sh-skill-drawer__prototype-identity-title">{t("skillLibrary.drawer.prototype.basicInformation")}</h3> : null}
        {!drawerPrototype && view.originalName && view.originalName !== view.name ? (
          <span className="sh-skill-drawer__original-name">
            <span className="sh-skill-drawer__field-label">{t("skillLibrary.drawer.values.originalName")}:</span>{" "}
            <span>{view.originalName}</span>
          </span>
        ) : null}
        <div className="sh-skill-drawer__summary-grid">
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--alias">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.drawer.values.alias")}
            </span>
            <div className="sh-skill-drawer__summary-value">
              {editingField === "alias" ? (
                <input
                  aria-label={t("skillLibrary.drawer.values.alias")}
                  autoFocus
                  onBlur={onCommit}
                  onChange={(event) => onChange(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onCommit();
                    if (event.key === "Escape") onCommit();
                  }}
                  type="text"
                  value={editingValue}
                />
              ) : (
                <span>{view.alias ?? <EmptyValue />}</span>
              )}
              <Button
                aria-label={t("skillLibrary.drawer.editAlias")}
                className="sh-skill-drawer__edit-icon"
                data-tooltip={t("skillLibrary.drawer.editAlias")}
                onClick={() => onBeginEdit("alias")}
                size="sm"
                variant="ghost"
              >
                <PencilIcon />
              </Button>
            </div>
          </div>
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--tags">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.drawer.values.tags")}
            </span>
            <div className="sh-skill-drawer__summary-value sh-skill-drawer__summary-tags">
              {view.tags.length > 0 ? (
                <ul className={`sh-skill-drawer__tag-list${drawerPrototype ? " sh-skill-drawer__prototype-tag-list" : ""}`}>
                  {displayedTags.map((tag) => (
                    <li className="sh-skill-drawer__tag" key={tag} title={tag}>
                      <span>{tag}</span>
                      <Button
                        aria-label={t("skillLibrary.drawer.removeTag", { tag })}
                        onClick={() => onRemoveTag(tag)}
                        size="sm"
                        variant="ghost"
                      >
                        <Icon name="close" size={16} />
                      </Button>
                    </li>
                  ))}
                  {hiddenTagCount > 0 ? (
                    <li className="sh-skill-drawer__prototype-tag-more">
                      <Button
                        aria-controls={tagPopoverId}
                        aria-expanded={tagPopover.open}
                        className="sh-skill-drawer__prototype-tag-more-button"
                        onClick={toggleTagPopover}
                        size="sm"
                        variant="secondary"
                      >
                        {t("skillLibrary.drawer.prototype.moreTags", { count: hiddenTagCount })}
                      </Button>
                    </li>
                  ) : null}
                </ul>
              ) : (
                <EmptyValue />
              )}
              <Button
                aria-label={t("skillLibrary.drawer.actions.addTags")}
                className="sh-skill-drawer__edit-icon"
                data-tooltip={t("skillLibrary.drawer.actions.addTags")}
                onClick={onAddTags}
                size="sm"
                variant="ghost"
              >
                <PencilIcon />
              </Button>
              {tagPopover.open ? (
                <PrototypePopover
                  ariaLabel={t("skillLibrary.drawer.prototype.allTags")}
                  className="sh-skill-drawer__prototype-tag-popover"
                  contentRef={tagPopover.contentRef}
                  id={tagPopoverId}
                  onCloseAutoFocus={tagPopover.onCloseAutoFocus}
                  onOpenChange={tagPopover.onOpenChange}
                  open={tagPopover.open}
                  position={tagPopover.position}
                  setPosition={tagPopover.setPosition}
                  triggerRef={tagPopover.triggerRef}
                >
                  <div className="sh-skill-drawer__prototype-tag-popover-heading">
                    <strong>{t("skillLibrary.drawer.prototype.allTags")}</strong>
                    <Button
                      aria-label={t("actions.close")}
                      onClick={() => tagPopover.close(true)}
                      size="sm"
                      variant="ghost"
                    >
                      <Icon name="close" size={16} />
                    </Button>
                  </div>
                  <ul>
                    {view.tags.map((tag) => (
                      <li key={tag}>
                        <span title={tag}>{tag}</span>
                        <Button
                          aria-label={t("skillLibrary.drawer.removeTag", { tag })}
                          onClick={() => onRemoveTag(tag)}
                          size="sm"
                          variant="ghost"
                        >
                          <Icon name="close" size={16} />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </PrototypePopover>
              ) : null}
            </div>
          </div>
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--lifecycle">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.filters.lifecycle")}
            </span>
            {drawerPrototype ? (
              <PrototypeLifecycleControl />
            ) : (
              <span className="sh-skill-drawer__summary-value sh-skill-drawer__lifecycle-value">
                {t(LIFECYCLE_LABEL_KEYS[view.lifecycle])}
              </span>
            )}
          </div>
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--version">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.filters.version")}
            </span>
            <span className="sh-skill-drawer__summary-value">{view.currentVersion}</span>
          </div>
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--agents">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.drawer.values.agentDestinations")}
            </span>
            <span className="sh-skill-drawer__summary-value">{view.agentDeploymentCount}</span>
          </div>
          <div className="sh-skill-drawer__summary-item sh-skill-drawer__summary-item--projects">
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.drawer.values.projectDestinations")}
            </span>
            <span className="sh-skill-drawer__summary-value">{view.projectDeploymentCount}</span>
          </div>
        </div>
      </div>
      <div className="sh-skill-drawer__field sh-skill-drawer__description-block">
        {drawerPrototype ? (
          <div className="sh-skill-drawer__prototype-description-row">
            <span className="sh-skill-drawer__field-label">{t("skillLibrary.drawer.values.originalDescription")}:</span>
            <span className="sh-skill-drawer__field-value">{view.originalDescription ?? <EmptyValue />}</span>
            <Button
              aria-label={t("skillLibrary.drawer.prototype.aiTranslate")}
              className="sh-skill-drawer__prototype-translate"
              data-tooltip={t("skillLibrary.drawer.prototype.aiTranslate")}
              disabled={translationLoading || !onTranslateDescription}
              onClick={onTranslateDescription}
              size="sm"
              variant="ghost"
              title={t("skillLibrary.drawer.prototype.translationPreview")}
            >
              {translationLoading ? <span className="sh-skill-drawer__prototype-translate-loading" aria-hidden="true" /> : <PrototypeTranslationIcon />}
            </Button>
          </div>
        ) : (
          <>
            <span className="sh-skill-drawer__field-label">
              {t("skillLibrary.drawer.values.originalDescription")}:
            </span>
            <span className="sh-skill-drawer__field-value">
            {view.originalDescription ?? <EmptyValue />}
          </span>
            {onTranslateDescription ? (
              <Button
                disabled={translationLoading}
                onClick={onTranslateDescription}
                size="sm"
                variant="ghost"
              >
                {translationLoading
                  ? t("skillLibrary.drawer.translation.inProgress")
                  : t("skillLibrary.drawer.translation.action")}
              </Button>
            ) : null}
          </>
        )}
        {drawerPrototype && !onTranslateDescription ? (
          <span className="sh-skill-drawer__prototype-translation-unavailable">
            <span>{t("skillLibrary.drawer.prototype.translationUnavailable")}</span>
            <Link to="/settings?section=networkAi">{t("skillLibrary.drawer.prototype.configureTranslation")}</Link>
          </span>
        ) : null}
        {drawerPrototype ? <span className="sh-visually-hidden">{t("skillLibrary.drawer.prototype.translationPreview")}</span> : null}
        {translationError ? <p role="alert">{translationError}</p> : null}
        {translationDraft ? (
          <div aria-label={t("skillLibrary.drawer.translation.confirmLabel")} role="alertdialog">
            <p>{translationDraft}</p>
            <Button onClick={onConfirmTranslation} size="sm">
              {t("skillLibrary.drawer.translation.useAsPurpose")}
            </Button>
            <Button onClick={onCancelTranslation} size="sm" variant="ghost">
              {t("actions.cancel")}
            </Button>
          </div>
        ) : null}
      </div>
      {(drawerPrototype ? prototypeTranslation : view.translatedDescription) ? (
        <div className="sh-skill-drawer__field">
          <span className="sh-skill-drawer__field-label">
            {t("skillLibrary.drawer.values.translatedDescription")}:
          </span>
          {drawerPrototype && translationEditing ? (
            <textarea aria-label={t("skillLibrary.drawer.prototype.editTranslation")} onChange={(event) => setTranslationEditDraft(event.currentTarget.value)} value={translationEditDraft} />
          ) : (
            <span className="sh-skill-drawer__field-value sh-skill-drawer__secondary">
              {drawerPrototype ? prototypeTranslation : view.translatedDescription}
            </span>
          )}
          {drawerPrototype ? (
            <div className="sh-skill-drawer__prototype-translation-actions">
              {translationEditing ? (
                <>
                  <Button onClick={() => { setPrototypeTranslation(translationEditDraft); setTranslationEditing(false); }} size="sm" variant="secondary">{t("skillLibrary.drawer.prototype.saveTranslationPreview")}</Button>
                  <Button onClick={() => { setTranslationEditDraft(prototypeTranslation); setTranslationEditing(false); }} size="sm" variant="ghost">{t("actions.cancel")}</Button>
                </>
              ) : (
                <>
                  <Button aria-label={t("skillLibrary.drawer.prototype.editTranslation")} className="sh-skill-drawer__prototype-translation-edit" data-tooltip={t("skillLibrary.drawer.prototype.editTranslation")} onClick={() => { setTranslationEditDraft(prototypeTranslation); setTranslationEditing(true); }} size="sm" title={t("skillLibrary.drawer.prototype.editTranslation")} variant="ghost">
                    <PencilIcon />
                  </Button>
                  <Button
                    aria-label={t("skillLibrary.drawer.prototype.useExistingTranslation")}
                    className="sh-skill-drawer__prototype-use-translation"
                    data-tooltip={t("skillLibrary.drawer.prototype.useExistingTranslation")}
                    onClick={() => onUseExistingTranslation?.(prototypeTranslation)}
                    size="sm"
                    title={t("skillLibrary.drawer.prototype.useExistingTranslation")}
                    variant="ghost"
                  >
                    {t("skillLibrary.drawer.prototype.setTranslationAsPurpose")}
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {/* M-21 #6：“我的用途”在抽屉内提供编辑入口；用途是用户独立撰写的
          元数据（QA-008），与原始描述/译文分开保存。 */}
      <div className="sh-skill-drawer__purpose-row">
        <span className="sh-skill-drawer__field-label">
          {t("skillLibrary.drawer.values.purpose")}:
        </span>
        {editingField === "purpose" ? (
          <input
            aria-label={t("skillLibrary.drawer.values.purpose")}
            autoFocus
            onBlur={onCommit}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommit();
              if (event.key === "Escape") onCommit();
            }}
            type="text"
            value={editingValue}
          />
        ) : (
          <span className="sh-skill-drawer__field-value">
            {(purposeOverride ?? view.purpose) || <EmptyValue />}
          </span>
        )}
        <Button
          aria-label={t("skillLibrary.drawer.editPurpose")}
          className="sh-skill-drawer__edit-icon"
          data-tooltip={t("skillLibrary.drawer.editPurpose")}
          onClick={() => onBeginEdit("purpose")}
          size="sm"
          variant="ghost"
        >
          <PencilIcon />
        </Button>
      </div>
      <div className="sh-skill-drawer__note">
        <span className="sh-skill-drawer__note-label">
          {t("skillLibrary.drawer.values.note")}:
        </span>
        {editingField === "note" ? (
          <input
            aria-label={t("skillLibrary.drawer.values.note")}
            autoFocus
            onBlur={onCommit}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommit();
              if (event.key === "Escape") onCommit();
            }}
            type="text"
            value={editingValue}
          />
        ) : (
          <span className="sh-skill-drawer__secondary">
            {view.note ?? <EmptyValue />}
          </span>
        )}
        <Button
          aria-label={t("skillLibrary.drawer.editNote")}
          className="sh-skill-drawer__edit-icon"
          data-tooltip={t("skillLibrary.drawer.editNote")}
          onClick={() => onBeginEdit("note")}
          size="sm"
          variant="ghost"
        >
          <PencilIcon />
        </Button>
      </div>
      {drawerPrototype ? (
        <div className="sh-skill-drawer__prototype-invocation">
          <div>
            <span className="sh-skill-drawer__field-label">{t("skillLibrary.drawer.values.invocation")}</span>
            <InvocationBadge policy={view.invocationPolicy} />
          </div>
          <div>
            <span className="sh-skill-drawer__field-label">{t("skillLibrary.drawer.prototype.requirements")}</span>
            <ValueList values={view.requirements} />
          </div>
        </div>
      ) : null}
    </section>
  );
}


interface PrototypePrimaryActionsProps extends ModuleProps {
  drawerPrototype?: boolean;
  onDelete?: (skillId: string, skillName: string) => void;
  /** 单技能来源更新检查；由宿主页面提供（与批量栏同一 facade 契约）。 */
  onCheckUpdates?: (skillId: string, skillName: string) => void;
}


function PrototypePrimaryActions({
  drawerPrototype = false,
  onCheckUpdates,
  onDelete,
  versionsHref,
  versionsState,
  view,
}: PrototypePrimaryActionsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const prototypeActionNoteId = useId();
  const prototypeActionPopover = useBoundedPrototypePopover();
  const [prototypeAction, setPrototypeAction] = useState<"dispatch" | "export" | "delete">("dispatch");
  const showPrototypeAction = (event: ReactMouseEvent<HTMLButtonElement>, action: "dispatch" | "export" | "delete") => {
    prototypeActionPopover.triggerRef.current = event.currentTarget;
    setPrototypeAction(action);
    prototypeActionPopover.setOpen(true);
  };
  if (drawerPrototype) {
    return (
      <>
        <section aria-label={t(MODULE_LABEL_KEYS.primary_actions)} className="sh-skill-drawer__actions sh-skill-drawer__prototype-actions">
          <div className="sh-skill-drawer__actions-main">
            <Button aria-describedby={prototypeActionNoteId} className="sh-skill-drawer__dispatch" data-prototype-action="true" onClick={(event) => showPrototypeAction(event, "dispatch")} size="sm" title={t("skillLibrary.drawer.prototype.previewOnly")} variant="primary">
              {t("skillLibrary.drawer.prototype.dispatch")}
            </Button>
            <Button aria-describedby={prototypeActionNoteId} data-prototype-action="true" onClick={(event) => showPrototypeAction(event, "export")} size="sm" title={t("skillLibrary.drawer.prototype.previewOnly")} variant="secondary">
              {t("skillLibrary.drawer.prototype.export")}
            </Button>
          </div>
          <Button aria-describedby={prototypeActionNoteId} className="sh-skill-drawer__delete-action" data-prototype-action="true" onClick={(event) => showPrototypeAction(event, "delete")} size="sm" title={t("skillLibrary.drawer.prototype.previewOnly")} variant="danger">
            {t("skillLibrary.drawer.prototype.delete")}
          </Button>
          <p className="sh-visually-hidden" id={prototypeActionNoteId}>{t("skillLibrary.drawer.prototype.previewOnly")}</p>
        </section>
        {prototypeActionPopover.open ? (
          <PrototypePopover
            ariaLabel={t(PROTOTYPE_ACTION_TITLE_KEYS[prototypeAction])}
            className={`sh-skill-drawer__prototype-popover sh-skill-drawer__prototype-action-popover sh-skill-drawer__prototype-action-popover--${prototypeAction}`}
            contentRef={prototypeActionPopover.contentRef}
            onCloseAutoFocus={prototypeActionPopover.onCloseAutoFocus}
            onOpenChange={prototypeActionPopover.onOpenChange}
            open={prototypeActionPopover.open}
            position={prototypeActionPopover.position}
            setPosition={prototypeActionPopover.setPosition}
            triggerRef={prototypeActionPopover.triggerRef}
          >
            <strong>{t(PROTOTYPE_ACTION_TITLE_KEYS[prototypeAction])}</strong>
            <p className="sh-skill-drawer__prototype-action-disclaimer">{t("skillLibrary.drawer.prototype.actionNoExecution")}</p>
            <section>
              <span>{t("skillLibrary.drawer.prototype.sampleImpactLabel")}</span>
              <p>{t(PROTOTYPE_ACTION_IMPACT_KEYS[prototypeAction], { skill: view.name })}</p>
            </section>
            <Button onClick={() => prototypeActionPopover.close(true)} size="sm" variant="secondary">
              {t("skillLibrary.drawer.prototype.cancelActionPreview")}
            </Button>
          </PrototypePopover>
        ) : null}
      </>
    );
  }
  // DEV-19（2026-09-20 收口）：抽屉动作与批量栏/详情页在「真实可用契约」
  // 范围内对齐——添加到…（/deploy 导航）、检查来源更新（check_source_updates）、
  // 发起导出（数据保护页导航）与删除全部可用，且单/批量双模式共用同一 i18n 键。
  // 「运行安全检查/提交导出任务/归档」仍依赖生产未绑定的 emitBatchIntent，
  // 后端能力落地前不恢复（诚实缺省，理由见 01d5ff21 与四份文档）。
  if (!onDelete && !onCheckUpdates) return null;
  return (
    <section aria-label={t(MODULE_LABEL_KEYS.primary_actions)} className="sh-skill-drawer__actions">
      <div className="sh-skill-drawer__actions-main">
        <Button
          className="sh-skill-drawer__dispatch"
          onClick={() => navigate(`/deploy?skill=${encodeURIComponent(view.id)}`)}
          size="sm"
          variant="primary"
        >
          {t("skillLibrary.page.batch.addTo")}
        </Button>
        {onCheckUpdates ? (
          <Button onClick={() => onCheckUpdates(view.id, view.name)} size="sm" variant="secondary">
            {t("skillLibrary.page.batch.checkUpdates")}
          </Button>
        ) : null}
        {versionsHref ? (
          <Link className="sh-button sh-button--secondary sh-button--sm" state={versionsState} to={versionsHref}>
            {t("skillLibrary.drawer.actions.viewVersions")}
          </Link>
        ) : null}
        <Button
          onClick={() => navigate("/settings/data-protection", { state: { exportSkillIds: [view.id] } })}
          size="sm"
          variant="secondary"
        >
          {t("skillLibrary.page.batch.startExport")}
        </Button>
      </div>
      {onDelete ? (
        <Button
          className="sh-skill-drawer__delete-action"
          onClick={() => onDelete(view.id, view.name)}
          size="sm"
          variant="danger"
        >
          {t("skillLibrary.drawer.actions.delete")}
        </Button>
      ) : null}
    </section>
  );
}


function ValueList({ values }: { values: string[] }) {
  return values.length > 0 ? (
    <ul className="sh-skill-drawer__value-list">
      {values.map((value) => (
        <li key={value}>{value}</li>
      ))}
    </ul>
  ) : (
    <EmptyValue />
  );
}
