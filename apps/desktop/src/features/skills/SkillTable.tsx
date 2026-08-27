import { useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
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

export interface SkillTableProps {
  onOpenSkill: (skillId: string, rowElement: HTMLElement) => void;
  onPreferencesChange: (preferences: SkillTablePreferences) => void;
  onQueryChange: (query: SkillLibraryQuery) => void;
  onSelectionChange: (selection: SkillSelection) => void;
  page: SkillPage;
  preferences: SkillTablePreferences;
  query: SkillLibraryQuery;
  returnPosition?: { focusSkillId: string; left: number; top: number };
  selection: SkillSelection;
}

interface SkillTableMeta {
  onRowCheck: (skillId: string, selected: boolean) => void;
  selection: SkillSelection;
  t: TFunction;
}

const LOCKED_COLUMNS: SkillColumnId[] = ["select", "name"];
const PAGE_SIZES = [10, 25, 50, 100] as const;
const COLUMN_IDS: SkillColumnId[] = [
  "select", "name", "purpose", "tags", "lifecycle", "deployments", "version", "security",
  "original_description", "translated_description", "source", "ownership", "license", "invocation", "requirements",
];

const COLUMN_LABELS = {
  deployments: "skillLibrary.table.columns.deployments",
  invocation: "skillLibrary.table.columns.invocation",
  license: "skillLibrary.table.columns.license",
  lifecycle: "skillLibrary.table.columns.lifecycle",
  name: "skillLibrary.table.columns.name",
  original_description: "skillLibrary.table.columns.originalDescription",
  ownership: "skillLibrary.table.columns.ownership",
  purpose: "skillLibrary.table.columns.purpose",
  requirements: "skillLibrary.table.columns.requirements",
  security: "skillLibrary.table.columns.security",
  select: "skillLibrary.table.columns.selection",
  source: "skillLibrary.table.columns.source",
  tags: "skillLibrary.table.columns.tags",
  translated_description: "skillLibrary.table.columns.translatedDescription",
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
  return value ? <span className="sh-skill-table__secondary" title={value}>{value}</span> : <span>—</span>;
}

function checkTone(state: CheckState) {
  if (state === "passed") return "success";
  if (state === "warning") return "warning";
  if (state === "failed") return "danger";
  return "info";
}

function SecurityCell({ row }: { row: SkillTableRow }) {
  const { t } = useTranslation();
  return (
    <div className="sh-skill-table__inline sh-skill-table__security">
      <span className={`sh-status-badge sh-status-badge--${checkTone(row.basicCheck)}`}>
        {t("skillLibrary.table.basicStatus", { state: t(CHECK_LABELS[row.basicCheck]) })}
      </span>
      <span className={`sh-status-badge sh-status-badge--${checkTone(row.aiCheck)}`}>
        {t("skillLibrary.table.aiStatus", { state: t(CHECK_LABELS[row.aiCheck]) })}
      </span>
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
      cell: ({ row }) => (
        <div className="sh-skill-table__inline sh-skill-table__name">
          <strong>{row.original.name}</strong>
          {row.original.alias ? (
            <span className="sh-skill-table__alias">
              <span className="sh-skill-table__alias-label">{t("skillLibrary.table.aliasLabel")}:</span> {row.original.alias}
            </span>
          ) : null}
          <span className="sh-skill-table__secondary" title={row.original.purpose}>{row.original.purpose}</span>
        </div>
      ),
      header: t(COLUMN_LABELS.name),
    },
    { accessorKey: "purpose", id: "purpose", cell: ({ row }) => secondary(row.original.purpose), header: t(COLUMN_LABELS.purpose) },
    { accessorKey: "tags", id: "tags", cell: ({ row }) => <span>{row.original.tags.join(", ")}</span>, header: t(COLUMN_LABELS.tags) },
    { accessorKey: "lifecycle", id: "lifecycle", cell: ({ row }) => <span>{t(LIFECYCLE_LABELS[row.original.lifecycle])}</span>, header: t(COLUMN_LABELS.lifecycle) },
    {
      id: "deployments",
      cell: ({ row }) => <div className="sh-skill-table__counts"><span>{t("skillLibrary.table.agentDeployments", { count: row.original.agentDeploymentCount })}</span><span>{t("skillLibrary.table.projectDeployments", { count: row.original.projectDeploymentCount })}</span></div>,
      header: t(COLUMN_LABELS.deployments),
    },
    {
      id: "version",
      cell: ({ row }) => <div className="sh-skill-table__version"><span>{row.original.currentVersion}</span>{row.original.upgradeAvailable ? <span>{t("skillLibrary.table.updateAvailable")}</span> : null}</div>,
      header: t(COLUMN_LABELS.version),
    },
    { id: "security", cell: ({ row }) => <SecurityCell row={row.original} />, header: t(COLUMN_LABELS.security) },
    { id: "original_description", cell: ({ row }) => secondary(row.original.originalDescription), header: t(COLUMN_LABELS.original_description) },
    { id: "translated_description", cell: ({ row }) => secondary(row.original.translatedDescription), header: t(COLUMN_LABELS.translated_description) },
    { accessorKey: "source", id: "source", cell: ({ row }) => secondary(row.original.source), header: t(COLUMN_LABELS.source) },
    { accessorKey: "ownership", id: "ownership", cell: ({ row }) => secondary(row.original.ownership), header: t(COLUMN_LABELS.ownership) },
    { accessorKey: "license", id: "license", cell: ({ row }) => secondary(row.original.license), header: t(COLUMN_LABELS.license) },
    { accessorKey: "invocation", id: "invocation", cell: ({ row }) => secondary(row.original.invocation), header: t(COLUMN_LABELS.invocation) },
    { id: "requirements", cell: ({ row }) => secondary(row.original.requirements.join(", ")), header: t(COLUMN_LABELS.requirements) },
  ];
}

function orderedColumnIds(preferences: SkillTablePreferences): SkillColumnId[] {
  const found = new Set<SkillColumnId>();
  const all = [...preferences.columnOrder, ...COLUMN_IDS].filter((id) => {
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
  const [draggedColumn, setDraggedColumn] = useState<SkillColumnId>();
  const [dragOverColumn, setDragOverColumn] = useState<SkillColumnId>();
  const columnOrder = orderedColumnIds(props.preferences);
  const visibleColumns = new Set([...LOCKED_COLUMNS, ...props.preferences.visibleColumns]);
  const columns = useMemo(() => createSkillColumns(t), [t]);
  const pageCount = Math.ceil(props.page.total / props.query.pageSize);
  const pageIds = props.page.items.map((row) => row.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((skillId) => isSelected(props.selection, skillId));

  const onRowCheck = (skillId: string, selected: boolean) => {
    if (props.selection.kind === "all_filtered") {
      props.onSelectionChange(excludeFromAllFiltered(props.selection, skillId, !selected));
      return;
    }
    props.onSelectionChange(selectExplicit(props.selection, [skillId], selected));
  };

  const table = useReactTable({
    columns,
    data: props.page.items,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    meta: { onRowCheck, selection: props.selection, t },
    pageCount,
    state: {
      columnOrder,
      columnVisibility: Object.fromEntries(COLUMN_IDS.map((id) => [id, visibleColumns.has(id)])),
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
    if (index < LOCKED_COLUMNS.length || targetIndex < LOCKED_COLUMNS.length || targetIndex >= next.length) return;
    next.splice(index, 1);
    next.splice(targetIndex, 0, column);
    props.onPreferencesChange({ ...props.preferences, columnOrder: next });
  };
  const moveColumnBefore = (column: SkillColumnId, before: SkillColumnId) => {
    if (column === before || LOCKED_COLUMNS.includes(column) || LOCKED_COLUMNS.includes(before)) return;
    const target = columnOrder.indexOf(before);
    if (target < LOCKED_COLUMNS.length) return;
    const nextTarget = columnOrder.indexOf(column) < target ? target - 1 : target;
    moveColumnToIndex(column, nextTarget);
  };
  const moveColumnByOffset = (column: SkillColumnId, offset: -1 | 1) => {
    const index = columnOrder.indexOf(column);
    moveColumnToIndex(column, index + offset);
  };
  const handleColumnDragOver = (event: DragEvent<HTMLDivElement>, column: SkillColumnId) => {
    if (!draggedColumn || draggedColumn === column || LOCKED_COLUMNS.includes(column)) return;
    event.preventDefault();
    setDragOverColumn(column);
  };
  const handleColumnDrop = (event: DragEvent<HTMLDivElement>, column: SkillColumnId) => {
    event.preventDefault();
    if (draggedColumn && draggedColumn !== column) moveColumnBefore(draggedColumn, column);
    setDraggedColumn(undefined);
    setDragOverColumn(undefined);
  };
  const start = props.page.total === 0 ? 0 : (props.page.page - 1) * props.page.pageSize + 1;
  const end = Math.min(props.page.page * props.page.pageSize, props.page.total);

  return (
    <section className="sh-skill-table-workspace">
      <div className="sh-skill-table__toolbar">
        <button aria-expanded={controlsOpen} aria-haspopup="dialog" className="sh-button sh-button--ghost sh-button--sm" onClick={() => setControlsOpen((open) => !open)} type="button">
          {t("skillLibrary.table.columnsAndDensity")}
        </button>
        {controlsOpen ? (
          <div aria-label={t("skillLibrary.table.columnsAndDensity")} className="sh-skill-table__controls" role="dialog">
            <fieldset>
              <legend>{t("skillLibrary.table.columnsLabel")}</legend>
              {columnOrder.map((column) => <label key={column}><input aria-label={t(COLUMN_LABELS[column])} checked={visibleColumns.has(column)} disabled={LOCKED_COLUMNS.includes(column)} onChange={(event) => toggleColumn(column, event.currentTarget.checked)} type="checkbox" />{t(COLUMN_LABELS[column])}</label>)}
            </fieldset>
            <fieldset>
              <legend>{t("skillLibrary.table.densityLabel")}</legend>
               {(["compact", "standard", "comfortable"] as const).map((density) => <label key={density}><input checked={props.preferences.density === density} name="skill-density" onChange={() => props.onPreferencesChange({ ...props.preferences, density })} type="radio" />{t(DENSITY_LABELS[density])}</label>)}
            </fieldset>
            <div aria-label={t("skillLibrary.table.reorderLabel")} className="sh-skill-table__reorder" role="list">
              {columnOrder.map((column) => {
                const locked = LOCKED_COLUMNS.includes(column);
                return (
                  <div
                    aria-label={t(COLUMN_LABELS[column])}
                    aria-roledescription={locked ? undefined : t("skillLibrary.table.dragColumn")}
                    className={`sh-skill-table__reorder-item${dragOverColumn === column ? " sh-skill-table__reorder-item--target" : ""}${locked ? " sh-skill-table__reorder-item--locked" : ""}`}
                    draggable={!locked}
                    key={column}
                    onDragEnd={() => {
                      setDraggedColumn(undefined);
                      setDragOverColumn(undefined);
                    }}
                    onDragOver={(event) => handleColumnDragOver(event, column)}
                    onDragStart={(event) => {
                      setDraggedColumn(column);
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                    }}
                    onDrop={(event) => handleColumnDrop(event, column)}
                    onKeyDown={(event) => {
                      if (locked || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
                      event.preventDefault();
                      moveColumnByOffset(column, event.key === "ArrowLeft" ? -1 : 1);
                    }}
                    role="listitem"
                    tabIndex={locked ? -1 : 0}
                  >
                    <span>{t(COLUMN_LABELS[column])}</span>
                    {locked ? <span className="sh-skill-table__reorder-lock">{t("skillLibrary.table.lockedColumn")}</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      <div aria-label={t("skillLibrary.table.resultsRegion")} className="sh-skill-table__region" ref={regionRef} role="region" tabIndex={-1}>
        <table className="sh-skill-table" data-density={props.preferences.density}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => <tr key={headerGroup.id}>{headerGroup.headers.map((header) => {
              const column = header.column.id as SkillColumnId;
              const sortable = column !== "select";
              const sort = props.query.sort.column === column ? props.query.sort.direction : undefined;
              return <th aria-sort={sortable ? (sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "none") : undefined} data-column={column} key={header.id} scope="col">
                {column === "select" ? <CheckboxTarget><input aria-label={t("skillLibrary.table.selectCurrentPage")} checked={allPageSelected} onChange={togglePage} onClick={stopRowOpen} onKeyDown={stopRowOpen} type="checkbox" /></CheckboxTarget> : sortable ? <button aria-label={t("skillLibrary.table.sortBy", { column: t(COLUMN_LABELS[column]).toLocaleLowerCase() })} className="sh-skill-table__sort" onClick={() => sortColumn(column)} type="button">{flexRender(header.column.columnDef.header, header.getContext())}</button> : flexRender(header.column.columnDef.header, header.getContext())}
              </th>;
            })}</tr>)}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => <tr data-skill-id={row.original.id} key={row.id} onClick={(event) => props.onOpenSkill(row.original.id, event.currentTarget)} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); props.onOpenSkill(row.original.id, event.currentTarget); } }} tabIndex={0}>
              {row.getVisibleCells().map((cell) => <td data-column={cell.column.id} key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
            </tr>)}
          </tbody>
        </table>
      </div>
      <footer className="sh-skill-table__pagination">
        <label>{t("skillLibrary.table.pageSize")}<select aria-label={t("skillLibrary.table.pageSize")} onChange={(event) => updateQuery({ page: 1, pageSize: Number(event.currentTarget.value) as SkillLibraryQuery["pageSize"] })} value={props.query.pageSize}>{PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
        <span>{t("skillLibrary.table.pageRange", { end, start, total: props.page.total })}</span>
        <button className="sh-button sh-button--secondary sh-button--sm" disabled={props.query.page <= 1} onClick={() => updateQuery({ page: props.query.page - 1 })} type="button">{t("skillLibrary.table.previousPage")}</button>
        <button className="sh-button sh-button--secondary sh-button--sm" disabled={props.query.page >= pageCount} onClick={() => updateQuery({ page: props.query.page + 1 })} type="button">{t("skillLibrary.table.nextPage")}</button>
      </footer>
    </section>
  );
}
