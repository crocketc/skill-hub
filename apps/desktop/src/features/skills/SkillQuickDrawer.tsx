import { useQuery } from "@tanstack/react-query";
import {
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { Button } from "../../ui/Button";
import { Drawer } from "../../ui/Drawer";
import type { SkillLibraryReturnState } from "../skill-detail/detailContext";
import {
  DEFAULT_DRAWER_PREFERENCES,
  type BatchAction,
  type CheckState,
  type DrawerModuleId,
  type DrawerPreset,
  type SkillDrawerPreferences,
  type SkillLibraryFacade,
  type SkillMetadataPatch,
  type SkillQuickView,
  skillLibraryKeys,
} from "./api";
import { InvocationBadge } from "./InvocationBadge";
import { BatchTagDialog, type BatchTagAction } from "./BatchTagDialog";
import {
  OPTIONAL_DRAWER_MODULES,
  clampDrawerWidth,
  drawerWidthForPreset,
  isRequiredDrawerModule,
  normalizeDrawerPreferences,
  reorderDrawerModule,
} from "./drawerModules";

export interface SkillQuickDrawerProps {
  detailSearch?: string;
  facade: SkillLibraryFacade;
  libraryReturn?: SkillLibraryReturnState;
  onOpenChange: (open: boolean) => void;
  onPreferencesChange: (preferences: SkillDrawerPreferences) => void;
  open: boolean;
  preferenceSaveFailed?: boolean;
  preferences: SkillDrawerPreferences;
  returnFocusRef: RefObject<HTMLElement | null>;
  skillId?: string;
}

type OptionalDrawerModule = (typeof OPTIONAL_DRAWER_MODULES)[number];

interface ModuleProps {
  view: SkillQuickView;
}

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
  invocation_requirements: "skillLibrary.drawer.modules.invocationRequirements",
  dependencies_duplicates: "skillLibrary.drawer.modules.dependenciesDuplicates",
  external_changes: "skillLibrary.drawer.modules.externalChanges",
  usage_evidence: "skillLibrary.drawer.modules.usageEvidence",
} as const;

const CHECK_STATE_KEYS = {
  failed: "skillLibrary.table.checkStates.failed",
  not_run: "skillLibrary.table.checkStates.notRun",
  passed: "skillLibrary.table.checkStates.passed",
  unavailable: "skillLibrary.table.checkStates.unavailable",
  warning: "skillLibrary.table.checkStates.warning",
} as const satisfies Record<CheckState, string>;

const PRESET_LABEL_KEYS = {
  near_full: "skillLibrary.drawer.presets.nearFull",
  standard: "skillLibrary.drawer.presets.standard",
  wide: "skillLibrary.drawer.presets.wide",
} as const satisfies Record<DrawerPreset, string>;

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

function RelationsModule({ view }: ModuleProps) {
  const { t } = useTranslation();
  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.relations)}>
      <dl className="sh-skill-drawer__facts">
        <div>
          <dt>{t("skillLibrary.drawer.values.agents")}</dt>
          <dd>{view.agentDeploymentCount}</dd>
        </div>
        <div>
          <dt>{t("skillLibrary.drawer.values.projects")}</dt>
          <dd>{view.projectDeploymentCount}</dd>
        </div>
      </dl>
    </ModuleCard>
  );
}

function VersionsModule({ view }: ModuleProps) {
  const { t } = useTranslation();
  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.versions)}>
      <p>{t("skillLibrary.drawer.values.currentVersion", { version: view.currentVersion })}</p>
      <p className="sh-skill-drawer__secondary">
        {view.upgradeAvailable
          ? t("skillLibrary.drawer.values.updateAvailable")
          : t("skillLibrary.drawer.values.upToDate")}
      </p>
    </ModuleCard>
  );
}

function SourceLicenseModule({ view }: ModuleProps) {
  const { t } = useTranslation();
  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.source_license)}>
      <dl className="sh-skill-drawer__facts sh-skill-drawer__facts--stacked">
        <div>
          <dt>{t("skillLibrary.drawer.values.source")}</dt>
          <dd>{view.source ?? <EmptyValue />}</dd>
        </div>
        <div>
          <dt>{t("skillLibrary.drawer.values.ownership")}</dt>
          <dd>{view.ownership ?? <EmptyValue />}</dd>
        </div>
        <div>
          <dt>{t("skillLibrary.drawer.values.license")}</dt>
          <dd>{view.license ?? <EmptyValue />}</dd>
        </div>
      </dl>
    </ModuleCard>
  );
}

function SecurityChecksModule({ view }: ModuleProps) {
  const { t } = useTranslation();
  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.security_checks)}>
      <dl className="sh-skill-drawer__facts">
        <div>
          <dt>{t("skillLibrary.filters.basicCheck")}</dt>
          <dd>{t(CHECK_STATE_KEYS[view.basicCheck])}</dd>
        </div>
        <div>
          <dt>{t("skillLibrary.filters.aiCheck")}</dt>
          <dd>{t(CHECK_STATE_KEYS[view.aiCheck])}</dd>
        </div>
      </dl>
    </ModuleCard>
  );
}

function InvocationRequirementsModule({ view }: ModuleProps) {
  const { t } = useTranslation();
  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.invocation_requirements)}>
      <p>
        <strong>{t("skillLibrary.drawer.values.invocation")}</strong>{" "}
        <InvocationBadge policy={view.invocationPolicy} />{" "}
        {view.invocation ?? <EmptyValue />}
      </p>
      <ValueList values={view.requirements} />
    </ModuleCard>
  );
}

function DependenciesDuplicatesModule({ view }: ModuleProps) {
  const { t } = useTranslation();
  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.dependencies_duplicates)}>
      <strong>{t("skillLibrary.drawer.values.dependencies")}</strong>
      <ValueList values={view.dependencies} />
      <strong>{t("skillLibrary.drawer.values.duplicates")}</strong>
      <ValueList values={view.duplicateCandidates} />
    </ModuleCard>
  );
}

function ExternalChangesModule({ view }: ModuleProps) {
  const { t } = useTranslation();
  return (
    <ModuleCard title={t(MODULE_LABEL_KEYS.external_changes)}>
      <ValueList values={view.externalChanges} />
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
  OptionalDrawerModule,
  ComponentType<ModuleProps>
> = {
  dependencies_duplicates: DependenciesDuplicatesModule,
  external_changes: ExternalChangesModule,
  invocation_requirements: InvocationRequirementsModule,
  relations: RelationsModule,
  security_checks: SecurityChecksModule,
  source_license: SourceLicenseModule,
  usage_evidence: UsageEvidenceModule,
  versions: VersionsModule,
};

interface IdentityRegionProps extends ModuleProps {
  editingField?: "alias" | "note";
  editingValue: string;
  onBeginEdit: (field: "alias" | "note") => void;
  onChange: (value: string) => void;
  onCommit: () => void;
}

function IdentityRegion({
  editingField,
  editingValue,
  onBeginEdit,
  onChange,
  onCommit,
  view,
}: IdentityRegionProps) {
  const { t } = useTranslation();
  return (
    <section className="sh-skill-drawer__identity">
      <div className="sh-skill-drawer__identity-heading">
        <h2>{view.name}</h2>
        <span className="sh-skill-drawer__field-label">
          {t("skillLibrary.drawer.values.alias")}:
        </span>
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
        <button
          aria-label={t("skillLibrary.drawer.editAlias")}
          className="sh-skill-drawer__edit-icon"
          onClick={() => onBeginEdit("alias")}
          title={t("skillLibrary.drawer.editAlias")}
          type="button"
        >
          <span aria-hidden="true">✎</span>
        </button>
      </div>
      <div className="sh-skill-drawer__field">
        <span className="sh-skill-drawer__field-label">
          {t("skillLibrary.drawer.values.originalDescription")}:
        </span>
        <span className="sh-skill-drawer__field-value">
          {view.originalDescription ?? <EmptyValue />}
        </span>
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
      <div className="sh-skill-drawer__field">
        <span className="sh-skill-drawer__field-label">
          {t("skillLibrary.drawer.values.purpose")}:
        </span>
        <span className="sh-skill-drawer__field-value">{view.purpose}</span>
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
        <button
          aria-label={t("skillLibrary.drawer.editNote")}
          className="sh-skill-drawer__edit-icon"
          onClick={() => onBeginEdit("note")}
          title={t("skillLibrary.drawer.editNote")}
          type="button"
        >
          <span aria-hidden="true">✎</span>
        </button>
      </div>
    </section>
  );
}

interface PrimaryActionsProps extends ModuleProps {
  facade: SkillLibraryFacade;
  onTagAction: (action: BatchTagAction) => void;
}

function PrimaryActions({ facade, onTagAction, view }: PrimaryActionsProps) {
  const { t } = useTranslation();
  const emitIntent = (action: BatchAction) => {
    void facade
      .emitBatchIntent({
        action,
        target: { kind: "skill_ids", skillIds: [view.id] },
      })
      .catch(() => undefined);
  };
  return (
    <section aria-label={t(MODULE_LABEL_KEYS.primary_actions)} className="sh-skill-drawer__actions">
      <Button onClick={() => emitIntent("add_to")} size="sm">
        {t("skillLibrary.drawer.actions.addTo")}
      </Button>
      <Button onClick={() => onTagAction("add_tag")} size="sm" variant="secondary">
        {t("skillLibrary.drawer.actions.addTags")}
      </Button>
      <Button onClick={() => onTagAction("remove_tag")} size="sm" variant="secondary">
        {t("skillLibrary.drawer.actions.removeTags")}
      </Button>
      <Button onClick={() => emitIntent("security_check")} size="sm" variant="secondary">
        {t("skillLibrary.drawer.actions.securityCheck")}
      </Button>
      <Button onClick={() => emitIntent("export")} size="sm" variant="ghost">
        {t("skillLibrary.drawer.actions.export")}
      </Button>
      <Button onClick={() => emitIntent("archive")} size="sm" variant="ghost">
        {t("skillLibrary.drawer.actions.archive")}
      </Button>
    </section>
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

interface DrawerConfigurationProps {
  onMoveAfter: (moved: DrawerModuleId, after: DrawerModuleId) => void;
  onMoveBefore: (moved: DrawerModuleId, before: DrawerModuleId) => void;
  onReset: () => void;
  onToggle: (moduleId: DrawerModuleId, visible: boolean) => void;
  preferences: SkillDrawerPreferences;
}

function DrawerConfiguration({
  onMoveAfter,
  onMoveBefore,
  onReset,
  onToggle,
  preferences,
}: DrawerConfigurationProps) {
  const { t } = useTranslation();
  const visible = new Set(preferences.visibleModules);
  const [draggedModule, setDraggedModule] = useState<DrawerModuleId | null>(null);
  const [dragOverModule, setDragOverModule] = useState<DrawerModuleId | null>(null);
  const suppressToggleClick = useRef(false);

  const clearDragState = () => {
    setDraggedModule(null);
    setDragOverModule(null);
  };

  return (
    <section
      aria-label={t("skillLibrary.drawer.configure")}
      className="sh-skill-drawer__configuration"
    >
      <fieldset className="sh-skill-drawer__module-toggles">
        <legend>{t("skillLibrary.drawer.moduleVisibility")}</legend>
        {preferences.moduleOrder.map((moduleId) => (
          <button
            aria-pressed={visible.has(moduleId)}
            className={`sh-skill-drawer__module-toggle${
              visible.has(moduleId) ? " sh-skill-drawer__module-toggle--visible" : ""
            }${
              isRequiredDrawerModule(moduleId)
                ? " sh-skill-drawer__module-toggle--locked"
                : ""
            }${dragOverModule === moduleId ? " sh-skill-drawer__module-toggle--target" : ""}`}
            disabled={isRequiredDrawerModule(moduleId)}
            draggable={!isRequiredDrawerModule(moduleId)}
            key={moduleId}
            onClick={() => {
              if (suppressToggleClick.current) {
                suppressToggleClick.current = false;
                return;
              }
              onToggle(moduleId, !visible.has(moduleId));
            }}
            onDragEnd={() => {
              clearDragState();
              window.setTimeout(() => {
                suppressToggleClick.current = false;
              }, 0);
            }}
            onDragOver={(event) => {
              if (draggedModule && draggedModule !== moduleId) {
                event.preventDefault();
                setDragOverModule(moduleId);
              }
            }}
            onDragStart={() => {
              suppressToggleClick.current = true;
              setDraggedModule(moduleId);
              setDragOverModule(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedModule && draggedModule !== moduleId) {
                const draggedIndex = preferences.moduleOrder.indexOf(draggedModule);
                const targetIndex = preferences.moduleOrder.indexOf(moduleId);
                if (draggedIndex < targetIndex) {
                  onMoveAfter(draggedModule, moduleId);
                } else {
                  onMoveBefore(draggedModule, moduleId);
                }
                suppressToggleClick.current = true;
                window.setTimeout(() => {
                  suppressToggleClick.current = false;
                }, 0);
              }
              clearDragState();
            }}
            type="button"
          >
            {t(MODULE_LABEL_KEYS[moduleId])}
          </button>
        ))}
      </fieldset>
      <Button onClick={onReset} size="sm" variant="secondary">
        {t("skillLibrary.drawer.reset")}
      </Button>
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
  facade,
  libraryReturn,
  onOpenChange,
  onPreferencesChange,
  open,
  preferenceSaveFailed,
  preferences,
  returnFocusRef,
  skillId,
}: SkillQuickDrawerProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [dragWidthPx, setDragWidthPx] = useState<number>();
  const [editingField, setEditingField] = useState<"alias" | "note">();
  const [editingValue, setEditingValue] = useState("");
  const [localPreferenceSaveFailed, setLocalPreferenceSaveFailed] = useState(false);
  const [localView, setLocalView] = useState<SkillQuickView>();
  const [tagAction, setTagAction] = useState<BatchTagAction>();
  const dragSessionRef = useRef<DragSession>();
  const preferenceSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const preferenceSaveRequestRef = useRef(0);
  const removePointerListenersRef = useRef<() => void>(() => undefined);
  const normalizedPreferences = normalizeDrawerPreferences(preferences);
  const visibleModules = new Set(normalizedPreferences.visibleModules);
  const optionalOrder = normalizedPreferences.moduleOrder.filter((moduleId) =>
    OPTIONAL_DRAWER_MODULES.includes(moduleId as OptionalDrawerModule),
  ) as OptionalDrawerModule[];
  const drawerViewportWidth = viewportWidth();
  const drawerMaximumWidth = Math.max(420, drawerViewportWidth - 32);
  const effectiveWidth = clampDrawerWidth(
    normalizedPreferences.widthPx,
    drawerViewportWidth,
  );
  const displayedWidth = dragWidthPx ?? effectiveWidth;
  const panelStyle: DrawerPanelStyle = {
    "--skill-drawer-width": `${displayedWidth}px`,
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

  const toggleModule = (moduleId: DrawerModuleId, visible: boolean) => {
    if (isRequiredDrawerModule(moduleId)) {
      return;
    }
    const nextVisible = visible
      ? [...normalizedPreferences.visibleModules, moduleId]
      : normalizedPreferences.visibleModules.filter((candidate) => candidate !== moduleId);
    persistPreferences({ ...normalizedPreferences, visibleModules: nextVisible });
  };

  const moveModuleBefore = (moved: DrawerModuleId, before: DrawerModuleId) => {
    persistPreferences({
      ...normalizedPreferences,
      moduleOrder: reorderDrawerModule(
        normalizedPreferences.moduleOrder,
        moved,
        before,
      ),
    });
  };

  const moveModuleAfter = (moved: DrawerModuleId, after: DrawerModuleId) => {
    const moduleOrder = [...normalizedPreferences.moduleOrder];
    const movedIndex = moduleOrder.indexOf(moved);
    const afterIndex = moduleOrder.indexOf(after);
    if (movedIndex < 0 || afterIndex < 0 || moved === after) {
      return;
    }
    moduleOrder.splice(movedIndex, 1);
    const nextAfterIndex = moduleOrder.indexOf(after);
    moduleOrder.splice(nextAfterIndex + 1, 0, moved);
    persistPreferences({ ...normalizedPreferences, moduleOrder });
  };

  const completeResize = (pointerId: number, persistWidth: boolean) => {
    const session = dragSessionRef.current;
    if (!session || pointerId !== session.pointerId) {
      return;
    }
    removePointerListenersRef.current();
    dragSessionRef.current = undefined;
    setDragWidthPx(undefined);
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
      lastWidth: displayedWidth,
      pointerId: event.pointerId,
      startWidth: displayedWidth,
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
      setDragWidthPx(nextWidth);
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
        ? displayedWidth + 16
        : event.key === "ArrowRight"
          ? displayedWidth - 16
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
    if (clampedWidth !== displayedWidth) {
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
      aria-valuenow={displayedWidth}
      className="sh-skill-drawer__resize"
      onKeyDown={resizeWithKeyboard}
      onLostPointerCapture={(event) => completeResize(event.pointerId, false)}
      onPointerDown={beginResize}
      role="separator"
      tabIndex={0}
    />
  );
  useEffect(() => {
    if (detailQuery.data) {
      setLocalView(detailQuery.data);
      setEditingField(undefined);
      setEditingValue("");
    } else {
      setLocalView(undefined);
    }
  }, [detailQuery.data]);

  const view = localView ?? detailQuery.data;

  const beginEdit = (field: "alias" | "note") => {
    if (!view) return;
    setEditingField(field);
    setEditingValue(field === "alias" ? view.alias ?? "" : view.note ?? "");
  };

  const commitEdit = () => {
    if (!editingField || !view) return;
    const value = editingValue.trim();
    const patch: SkillMetadataPatch =
      editingField === "alias" ? { alias: value || null } : { note: value || null };
    setLocalView({
      ...view,
      ...(editingField === "alias"
        ? { alias: value || undefined }
        : { note: value || undefined }),
    });
    setEditingField(undefined);
    setEditingValue("");
    const save = facade.saveSkillMetadata?.(view.id, patch);
    void save?.catch(() => undefined);
  };

  const confirmTagAction = (tags: string[]) => {
    if (!tagAction || !view) return;
    const action = tagAction;
    setTagAction(undefined);
    void facade
      .emitBatchIntent({
        action,
        tags,
        target: { kind: "skill_ids", skillIds: [view.id] },
      })
      .catch(() => undefined);
  };

  return (
    <Drawer
      description={t("skillLibrary.drawer.description")}
      hideHeader
      leadingAccessory={resizeHandle}
      onOpenChange={onOpenChange}
      open={open}
      panelClassName="sh-skill-drawer"
      panelStyle={panelStyle}
      returnFocusRef={returnFocusRef}
      title={view?.name ?? t("skillLibrary.drawer.title")}
    >
      <div
        className="sh-skill-drawer__layout"
        data-preset={normalizedPreferences.preset}
        data-testid="skill-quick-drawer"
        style={panelStyle}
      >
        <div className="sh-skill-drawer__chrome">
          <div className="sh-skill-drawer__toolbar">
            {view && skillId ? (
              <Link
                className="sh-button sh-button--primary sh-button--sm"
                state={libraryReturn ? { libraryReturn } : undefined}
                to={{ pathname: `${location.pathname.startsWith("/__preview") ? "/__preview/skill-detail" : "/library"}/${skillId}`, search: detailSearch }}
              >
                {t("skillLibrary.drawer.fullDetails")}
              </Link>
            ) : <span />}
            <div className="sh-skill-drawer__toolbar-end">
              <Button
                aria-expanded={configurationOpen}
                onClick={() => setConfigurationOpen((current) => !current)}
                size="sm"
                variant="ghost"
              >
                {t("skillLibrary.drawer.configure")}
              </Button>
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
              <Button
                aria-label={t("actions.close")}
                className="sh-skill-drawer__close-button"
                onClick={() => onOpenChange(false)}
                size="sm"
                variant="ghost"
              >
                <span aria-hidden="true">×</span>
              </Button>
            </div>
          </div>

          {(preferenceSaveFailed ?? localPreferenceSaveFailed) ? (
            <p className="sh-skill-drawer__alert" role="alert">
              {t("skillLibrary.drawer.preferenceFailure")}
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
            <div className="sh-skill-drawer__fixed">
              <IdentityRegion
                editingField={editingField}
                editingValue={editingValue}
                onBeginEdit={beginEdit}
                onChange={setEditingValue}
                onCommit={commitEdit}
                view={view}
              />
              <PrimaryActions facade={facade} onTagAction={setTagAction} view={view} />
              <RiskSummary view={view} />
            </div>
          ) : null}
        </div>

        <div
          className="sh-skill-drawer__scroll"
          data-testid="drawer-modules-scroll"
        >
          {configurationOpen ? (
            <DrawerConfiguration
              onMoveAfter={moveModuleAfter}
              onMoveBefore={moveModuleBefore}
              onReset={() =>
                persistPreferences({
                  ...DEFAULT_DRAWER_PREFERENCES,
                  moduleOrder: [...DEFAULT_DRAWER_PREFERENCES.moduleOrder],
                  visibleModules: [...DEFAULT_DRAWER_PREFERENCES.visibleModules],
                })
              }
              onToggle={toggleModule}
              preferences={normalizedPreferences}
            />
          ) : null}
          {view ? (
            <div className="sh-skill-drawer__modules">
              {optionalOrder.map((moduleId) => {
                if (!visibleModules.has(moduleId)) {
                  return null;
                }
                const ModuleRenderer = OPTIONAL_MODULE_RENDERERS[moduleId];
                return <ModuleRenderer key={moduleId} view={view} />;
              })}
            </div>
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
