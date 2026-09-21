import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  type CheckState,
  type SkillColumnId,
  type SkillLibraryQuery,
  type SkillPage,
  type SkillTablePreferences,
  type SkillTableRow,
} from "./api";
import {
  excludeFromAllFiltered,
  selectExplicit,
  setPageSelection,
  type SkillSelection,
} from "./selection";
import { InvocationBadge } from "./InvocationBadge";
import { AgentDeploymentIcons } from "./AgentDeploymentIcons";
import { RadioField } from "../../ui/RadioField";
import { SkillPagination } from "./SkillPagination";

export interface SkillTableProps {
  onOpenSkill: (skillId: string, rowElement: HTMLElement) => void;
  onPreferencesChange: (preferences: SkillTablePreferences) => void;
  onQueryChange: (query: SkillLibraryQuery) => void;
  onSelectionChange: (selection: SkillSelection) => void;
  page: SkillPage;
  pageStatus?: ReactNode;
  preferences: SkillTablePreferences;
  query: SkillLibraryQuery;
  returnPosition?: { focusSkillId: string; left: number; top: number };
  selection: SkillSelection;
  /** Columns the current facade can actually sort on. Omitted means every
   * column stays sortable (browser preview and test doubles). */
  sortableColumns?: SkillColumnId[];
}

interface SkillTableMeta {
  onRowCheck: (skillId: string, selected: boolean) => void;
  selection: SkillSelection;
  t: TFunction;
}

const LOCKED_COLUMNS: SkillColumnId[] = ["select", "name"];
// 导出全列集合（审查 C4，2026-09-14）：测试用它做长度/集合断言，
// 防止新增列时测试夹具静默失守。
export const COLUMN_IDS: SkillColumnId[] = [
  "select", "name", "purpose", "tags", "invocation", "agent_deployments", "project_deployments", "version", "security_status", "security_results",
  "source", "ownership", "license", "requirements", "lifecycle",
];

const COLUMN_LABELS = {
  agent_deployments: "skillLibrary.table.columns.agentDeployments",
  invocation: "skillLibrary.table.columns.invocation",
  license: "skillLibrary.table.columns.license",
  lifecycle: "skillLibrary.table.columns.lifecycle",
  name: "skillLibrary.table.columns.name",
  ownership: "skillLibrary.table.columns.ownership",
  project_deployments: "skillLibrary.table.columns.projectDeployments",
  purpose: "skillLibrary.table.columns.purpose",
  requirements: "skillLibrary.table.columns.requirements",
  security_results: "skillLibrary.table.columns.securityResults",
  security_status: "skillLibrary.table.columns.securityStatus",
  select: "skillLibrary.table.columns.selection",
  source: "skillLibrary.table.columns.source",
  tags: "skillLibrary.table.columns.tags",
  version: "skillLibrary.table.columns.version",
} as const satisfies Record<SkillColumnId, string>;

const CHECK_LABELS = {
  failed: "skillLibrary.table.checkStates.failed",
  not_run: "skillLibrary.table.checkStates.notRun",
  passed: "skillLibrary.table.checkStates.passed",
  unavailable: "skillLibrary.table.checkStates.unavailable",
  warning: "skillLibrary.table.checkStates.warning",
} as const satisfies Record<CheckState, string>;

const LIFECYCLE_LABELS = {
  active: "skillLibrary.table.lifecycle.active",
  archived: "skillLibrary.table.lifecycle.archived",
  trial: "skillLibrary.table.lifecycle.trial",
} as const;

const DENSITY_LABELS = {
  comfortable: "skillLibrary.table.density.comfortable",
  compact: "skillLibrary.table.density.compact",
  standard: "skillLibrary.table.density.standard",
} as const;

function stopRowOpen(event: MouseEvent | KeyboardEvent) {
  event.stopPropagation();
}

function CheckboxTarget({ children }: { children: ReactNode }) {
  return (
    <label
      className="sh-skill-table__checkbox-target"
      onClick={stopRowOpen}
      onKeyDown={stopRowOpen}
    >
      {children}
    </label>
  );
}

function tableMeta(table: { options: { meta?: unknown } }): SkillTableMeta {
  return table.options.meta as SkillTableMeta;
}

function secondary(value: string | undefined) {
  return value ? (
    <span aria-label={value} className="sh-skill-table__secondary" tabIndex={0} title={value}>{value}</span>
  ) : <span>—</span>;
}

function tagBadges(tags: string[]) {
  if (!tags.length) return <span>—</span>;
  return (
    <div className="sh-skill-table__tag-list">
      {tags.map((tag) => (
        <span aria-label={tag} className="sh-skill-table__tag" key={tag} tabIndex={0} title={tag}>{tag}</span>
      ))}
    </div>
  );
}

function checkTone(state: CheckState) {
  if (state === "passed") return "success";
  if (state === "warning") return "warning";
  if (state === "failed") return "danger";
  return "info";
}

function SecurityStatusCell({ row }: { row: SkillTableRow }) {
  const { t } = useTranslation();
  return (
    <div className="sh-skill-table__inline sh-skill-table__security">
      <span className={`sh-status-badge sh-status-badge--${checkTone(row.basicCheck)}`}>
        {t("skillLibrary.table.basicStatus", { state: t(CHECK_LABELS[row.basicCheck]) })}
      </span>
      <span className={`sh-status-badge sh-status-badge--${checkTone(row.aiCheck)}`}>
        {t("skillLibrary.table.aiStatus", { state: t(CHECK_LABELS[row.aiCheck]) })}
      </span>
    </div>
  );
}

function SecurityResultsCell({ row }: { row: SkillTableRow }) {
  const { t } = useTranslation();
  return (
    <div className="sh-skill-table__inline sh-skill-table__security-results">
      <span>{t("skillLibrary.table.pendingCount", { count: row.pendingCount })}</span>
      <span>{t("skillLibrary.table.highRiskCount", { count: row.highRiskCount })}</span>
    </div>
  );
}

export function createSkillColumns(t: TFunction): ColumnDef<SkillTableRow>[] {
  return [
    {
      id: "select",
      cell: ({ row, table }) => {
        const meta = tableMeta(table);
        const selected = meta.selection.kind === "all_filtered"
          ? !meta.selection.excludedSkillIds.includes(row.original.id)
          : meta.selection.kind === "explicit" && meta.selection.skillIds.includes(row.original.id);
        return (
          <CheckboxTarget>
            <input
              aria-label={meta.t("skillLibrary.table.selectSkill", { name: row.original.name })}
              checked={selected}
              className="sh-control-checkbox"
              onChange={(event) => meta.onRowCheck(row.original.id, event.currentTarget.checked)}
              onClick={stopRowOpen}
              onKeyDown={stopRowOpen}
              type="checkbox"
            />
          </CheckboxTarget>
        );
      },
      header: t(COLUMN_LABELS.select),
    },
    {
      accessorKey: "name",
      id: "name",
      // P1-10：别名场景下同时展示展示名（主）与原名（次）；无别名时仅展示名。
      cell: ({ row }) => (
        <div className="sh-skill-table__inline sh-skill-table__name">
          <strong>{row.original.name}</strong>
          {row.original.originalName && row.original.originalName !== row.original.name ? (
            <span aria-label={row.original.originalName} className="sh-skill-table__alias" tabIndex={0} title={row.original.originalName}>
              <span className="sh-skill-table__alias-label">{t("skillLibrary.table.originalNameLabel")}:</span> {row.original.originalName}
            </span>
          ) : null}
        </div>
      ),
      header: t(COLUMN_LABELS.name),
    },
    { accessorKey: "purpose", id: "purpose", cell: ({ row }) => secondary(row.original.purpose), header: t(COLUMN_LABELS.purpose) },
    { accessorKey: "tags", id: "tags", cell: ({ row }) => tagBadges(row.original.tags), header: t(COLUMN_LABELS.tags) },
    { accessorKey: "lifecycle", id: "lifecycle", cell: ({ row }) => <span>{t(LIFECYCLE_LABELS[row.original.lifecycle])}</span>, header: t(COLUMN_LABELS.lifecycle) },
    {
      id: "agent_deployments",
      cell: ({ row }) => (
        <AgentDeploymentIcons
          agents={row.original.agentDeployments ?? []}
          ariaLabel={t("skillLibrary.table.agentDeploymentSummary", { count: row.original.agentDeploymentCount })}
        />
      ),
      header: t(COLUMN_LABELS.agent_deployments),
    },
    {
      id: "project_deployments",
      cell: ({ row }) => <span>{t("skillLibrary.table.projectDeployments", { count: row.original.projectDeploymentCount })}</span>,
      header: t(COLUMN_LABELS.project_deployments),
    },
    {
      id: "version",
      cell: ({ row }) => <div className="sh-skill-table__version"><span>{row.original.currentVersion}</span>{row.original.upgradeAvailable ? <span>{t("skillLibrary.table.updateAvailable")}</span> : null}</div>,
      header: t(COLUMN_LABELS.version),
    },
    { id: "security_status", cell: ({ row }) => <SecurityStatusCell row={row.original} />, header: t(COLUMN_LABELS.security_status) },
    { id: "security_results", cell: ({ row }) => <SecurityResultsCell row={row.original} />, header: t(COLUMN_LABELS.security_results) },
    { accessorKey: "source", id: "source", cell: ({ row }) => secondary(row.original.source), header: t(COLUMN_LABELS.source) },
    { accessorKey: "ownership", id: "ownership", cell: ({ row }) => secondary(row.original.ownership), header: t(COLUMN_LABELS.ownership) },
    { accessorKey: "license", id: "license", cell: ({ row }) => secondary(row.original.license), header: t(COLUMN_LABELS.license) },
    {
      id: "invocation",
      cell: ({ row }) => (
        <div className="sh-skill-table__invocation-cell"><InvocationBadge policy={row.original.invocationPolicy} /></div>
      ),
      header: t(COLUMN_LABELS.invocation),
    },
    { id: "requirements", cell: ({ row }) => secondary(row.original.requirements.join(", ")), header: t(COLUMN_LABELS.requirements) },
  ];
}

function orderedColumnIds(preferences: SkillTablePreferences): SkillColumnId[] {
  const found = new Set<SkillColumnId>();
  const all = [...preferences.columnOrder, ...COLUMN_IDS].filter((id) => {
    if (!COLUMN_IDS.includes(id)) return false;
    if (found.has(id)) return false;
    found.add(id);
    return true;
  });
  return [...LOCKED_COLUMNS, ...all.filter((id) => !LOCKED_COLUMNS.includes(id))];
}

function isSelected(selection: SkillSelection, skillId: string) {
  if (selection.kind === "all_filtered") return !selection.excludedSkillIds.includes(skillId);
  return selection.kind === "explicit" && selection.skillIds.includes(skillId);
}

export function SkillTable(props: SkillTableProps) {
  const { t } = useTranslation();
  const regionRef = useRef<HTMLDivElement>(null);
  const restoredKeyRef = useRef<string>();
  const [controlsOpen, setControlsOpen] = useState(false);
  const [dragOverColumn, setDragOverColumn] = useState<SkillColumnId>();
  const dragOverColumnRef = useRef<SkillColumnId>();
  const suppressToggleClickRef = useRef(false);
  const pointerDragRef = useRef<{
    column: SkillColumnId;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  }>();
  const sortable = new Set(props.sortableColumns ?? COLUMN_IDS);
  const columnOrder = useMemo(() => orderedColumnIds(props.preferences), [props.preferences]);
  const visibleColumns = useMemo(
    () => new Set([...LOCKED_COLUMNS, ...props.preferences.visibleColumns]),
    [props.preferences],
  );
  const columns = useMemo(() => createSkillColumns(t), [t]);
  const pageCount = Math.ceil(props.page.total / props.query.pageSize);
  const pageIds = useMemo(() => props.page.items.map((row) => row.id), [props.page.items]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((skillId) => isSelected(props.selection, skillId));

  const onRowCheck = useCallback((skillId: string, selected: boolean) => {
    if (props.selection.kind === "all_filtered") {
      props.onSelectionChange(excludeFromAllFiltered(props.selection, skillId, !selected));
      return;
    }
    props.onSelectionChange(selectExplicit(props.selection, [skillId], selected));
  }, [props.onSelectionChange, props.selection]);

  const meta = useMemo(
    () => ({ onRowCheck, selection: props.selection, t }),
    [onRowCheck, props.selection, t],
  );
  const columnVisibility = useMemo(
    () => Object.fromEntries(COLUMN_IDS.map((id) => [id, visibleColumns.has(id)])),
    [visibleColumns],
  );

  const table = useReactTable({
    columns,
    data: props.page.items,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    meta,
    pageCount,
    state: {
      columnOrder,
      columnVisibility,
      pagination: { pageIndex: props.query.page - 1, pageSize: props.query.pageSize },
      sorting: [{ desc: props.query.sort.direction === "desc", id: props.query.sort.column }],
    },
  });

  useLayoutEffect(() => {
    const position = props.returnPosition;
    const region = regionRef.current;
    if (!position || !region) return;
    const key = `${position.focusSkillId}:${position.left}:${position.top}`;
    if (restoredKeyRef.current === key) return;
    restoredKeyRef.current = key;
    const row = [...region.querySelectorAll<HTMLElement>("[data-skill-id]")]
      .find((element) => element.dataset.skillId === position.focusSkillId);
    (row ?? region).focus({ preventScroll: true });
    region.scrollLeft = position.left;
    region.scrollTop = position.top;
  }, [props.page.items, props.returnPosition]);

  const updateQuery = (change: Partial<SkillLibraryQuery>) => props.onQueryChange({ ...props.query, ...change });
  const sortColumn = (column: SkillColumnId) => updateQuery({
    page: 1,
    sort: {
      column,
      direction: props.query.sort.column === column && props.query.sort.direction === "asc" ? "desc" : "asc",
    },
  });
  const togglePage = (event: ChangeEvent<HTMLInputElement>) =>
    props.onSelectionChange(
      setPageSelection(props.selection, pageIds, event.currentTarget.checked),
    );
  const toggleColumn = (column: SkillColumnId, visible: boolean) => props.onPreferencesChange({
    ...props.preferences,
    visibleColumns: visible
      ? [...new Set([...props.preferences.visibleColumns, column])]
      : props.preferences.visibleColumns.filter((id) => id !== column),
  });
  const moveColumnToIndex = (column: SkillColumnId, targetIndex: number) => {
    const next = [...columnOrder];
    const index = next.indexOf(column);
    if (index < LOCKED_COLUMNS.length || targetIndex < LOCKED_COLUMNS.length || targetIndex > next.length) return;
    next.splice(index, 1);
    next.splice(targetIndex, 0, column);
    props.onPreferencesChange({ ...props.preferences, columnOrder: next });
  };
  const moveColumnBefore = (column: SkillColumnId, before: SkillColumnId) => {
    if (column === before || LOCKED_COLUMNS.includes(column) || LOCKED_COLUMNS.includes(before)) return;
    const target = columnOrder.indexOf(before);
    if (target < LOCKED_COLUMNS.length) return;
    moveColumnToIndex(column, target);
  };
  const moveColumnByOffset = (column: SkillColumnId, offset: -1 | 1) => {
    const index = columnOrder.indexOf(column);
    moveColumnToIndex(column, index + offset);
  };
  const columnAtPoint = (clientX: number, clientY: number, fallback?: Element): SkillColumnId | undefined => {
    const element = document.elementFromPoint?.(clientX, clientY) ?? fallback;
    const item = element?.closest<HTMLElement>("[data-reorder-column]");
    const column = item?.dataset.reorderColumn as SkillColumnId | undefined;
    return column && COLUMN_IDS.includes(column) ? column : undefined;
  };
  const releaseColumnPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerDragRef.current = undefined;
    dragOverColumnRef.current = undefined;
    setDragOverColumn(undefined);
  };
  const handleColumnPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, column: SkillColumnId) => {
    if (LOCKED_COLUMNS.includes(column) || (event.button !== undefined && event.button !== 0)) return;
    pointerDragRef.current = {
      active: false,
      column,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  };
  const handleColumnPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = pointerDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!session.active && Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < 4) return;
    if (!session.active) {
      session.active = true;
      suppressToggleClickRef.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const column = columnAtPoint(event.clientX, event.clientY, event.currentTarget);
    if (column && session.column !== column && !LOCKED_COLUMNS.includes(column)) {
      event.preventDefault();
      dragOverColumnRef.current = column;
      setDragOverColumn(column);
    } else {
      dragOverColumnRef.current = undefined;
      setDragOverColumn(undefined);
    }
  };
  const handleColumnPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = pointerDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const column = dragOverColumnRef.current
      ?? columnAtPoint(event.clientX, event.clientY, event.currentTarget);
    if (session.active && column && session.column !== column && !LOCKED_COLUMNS.includes(column)) {
      moveColumnBefore(session.column, column);
      suppressToggleClickRef.current = true;
      window.setTimeout(() => {
        suppressToggleClickRef.current = false;
      }, 0);
    }
    releaseColumnPointer(event);
  };

  return (
    <section className="sh-skill-table-workspace">
      <div className="sh-skill-table__toolbar">
        <button aria-expanded={controlsOpen} aria-haspopup="dialog" className="sh-button sh-button--ghost sh-button--sm" onClick={() => setControlsOpen((open) => !open)} type="button">
          {t("skillLibrary.table.columnsAndDensity")}
        </button>
        {props.pageStatus ? <p className="sh-skill-table__page-status">{props.pageStatus}</p> : null}
        {controlsOpen ? (
          <div aria-label={t("skillLibrary.table.columnsAndDensity")} className="sh-skill-table__controls" role="dialog">
            <fieldset>
              <legend>{t("skillLibrary.table.columnsLabel")}</legend>
              <div aria-label={t("skillLibrary.table.reorderLabel")} className="sh-skill-table__reorder" role="list">
                {columnOrder.map((column) => {
                  const locked = LOCKED_COLUMNS.includes(column);
                  const visible = visibleColumns.has(column);
                  return (
                    <div key={column} role="listitem">
                      <button
                        aria-label={t(COLUMN_LABELS[column])}
                        aria-pressed={visible}
                        aria-roledescription={locked ? undefined : t("skillLibrary.table.dragColumn")}
                        data-reorder-column={column}
                        className={`sh-skill-table__reorder-item${visible ? " sh-skill-table__reorder-item--visible" : ""}${dragOverColumn === column ? " sh-skill-table__reorder-item--target" : ""}${locked ? " sh-skill-table__reorder-item--locked" : ""}`}
                        disabled={locked}
                        draggable={false}
                        onClick={() => {
                          if (suppressToggleClickRef.current) {
                            suppressToggleClickRef.current = false;
                            return;
                          }
                          toggleColumn(column, !visible);
                        }}
                        onPointerCancel={() => {
                          pointerDragRef.current = undefined;
                          dragOverColumnRef.current = undefined;
                          setDragOverColumn(undefined);
                        }}
                        onPointerDown={(event) => handleColumnPointerDown(event, column)}
                        onPointerMove={handleColumnPointerMove}
                        onPointerUp={handleColumnPointerUp}
                        onKeyDown={(event) => {
                          if (locked || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
                          event.preventDefault();
                          moveColumnByOffset(column, event.key === "ArrowLeft" ? -1 : 1);
                        }}
                        type="button"
                      >
                        <span>{t(COLUMN_LABELS[column])}</span>
                        {locked ? <span className="sh-skill-table__reorder-lock">{t("skillLibrary.table.lockedColumn")}</span> : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            </fieldset>
            <fieldset>
              <legend>{t("skillLibrary.table.densityLabel")}</legend>
              {(["compact", "standard", "comfortable"] as const).map((density) => (
                <RadioField
                  checked={props.preferences.density === density}
                  key={density}
                  label={t(DENSITY_LABELS[density])}
                  name="skill-density"
                  onChange={() => props.onPreferencesChange({ ...props.preferences, density })}
                />
              ))}
            </fieldset>
          </div>
        ) : null}
      </div>
      <div className="sh-skill-table__region-shell">
        <div aria-label={t("skillLibrary.table.resultsRegion")} className="sh-skill-table__region" ref={regionRef} role="region" tabIndex={-1}>
          <table className="sh-skill-table" data-density={props.preferences.density}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => <tr key={headerGroup.id}>{headerGroup.headers.map((header) => {
              const column = header.column.id as SkillColumnId;
              const isSortable = column !== "select" && sortable.has(column);
              const sort = props.query.sort.column === column ? props.query.sort.direction : undefined;
              return <th aria-sort={isSortable ? (sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "none") : undefined} data-column={column} key={header.id} scope="col">
                {column === "select" ? <CheckboxTarget><input aria-label={t("skillLibrary.table.selectCurrentPage")} checked={allPageSelected} className="sh-control-checkbox" onChange={togglePage} onClick={stopRowOpen} onKeyDown={stopRowOpen} type="checkbox" /></CheckboxTarget> : isSortable ? <button aria-label={t("skillLibrary.table.sortBy", { column: t(COLUMN_LABELS[column]).toLocaleLowerCase() })} className="sh-skill-table__sort" onClick={() => sortColumn(column)} type="button">{flexRender(header.column.columnDef.header, header.getContext())}</button> : flexRender(header.column.columnDef.header, header.getContext())}
              </th>;
            })}</tr>)}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => <tr data-agent-deployment-rows={Math.min(2, Math.ceil((row.original.agentDeployments?.length ?? 0) / 5)) || 1} data-skill-id={row.original.id} key={row.id} onClick={(event) => props.onOpenSkill(row.original.id, event.currentTarget)} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); props.onOpenSkill(row.original.id, event.currentTarget); } }} tabIndex={0}>
              {row.getVisibleCells().map((cell) => <td data-column={cell.column.id} key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
            </tr>)}
          </tbody>
          </table>
        </div>
      </div>
      <SkillPagination
        className="sh-skill-table__pagination"
        onPageChange={(page) => updateQuery({ page })}
        onPageSizeChange={(pageSize) => updateQuery({ page: 1, pageSize })}
        page={props.page}
        query={props.query}
      />
    </section>
  );
}
