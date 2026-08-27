import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import "../../styles/base.css";
import baseCss from "../../styles/base.css?raw";
import {
  DEFAULT_SKILL_QUERY,
  DEFAULT_TABLE_PREFERENCES,
  type SkillPage,
  type SkillTableRow,
} from "./api";
import { SkillTable, type SkillTableProps } from "./SkillTable";

const rows: SkillTableRow[] = [
  {
    aiCheck: "unavailable",
    agentDeploymentCount: 2,
    alias: "reader",
    basicCheck: "passed",
    currentVersion: "1.4.0",
    highRiskCount: 0,
    id: "skill-pdf",
    invocation: "pdf-reader",
    license: "MIT",
    lifecycle: "active",
    name: "PDF Reader",
    originalDescription: "Extracts text from PDF files.",
    ownership: "Platform team",
    pendingCount: 1,
    projectDeploymentCount: 3,
    purpose: "Read and extract PDFs",
    requirements: ["Python 3.11"],
    source: "Internal catalog",
    tags: ["documents", "pdf"],
    translatedDescription: "Reads PDF files.",
    upgradeAvailable: true,
  },
  {
    aiCheck: "not_run",
    agentDeploymentCount: 0,
    basicCheck: "warning",
    currentVersion: "2.0.0",
    highRiskCount: 2,
    id: "skill-notes",
    lifecycle: "trial",
    name: "Notes Helper",
    pendingCount: 2,
    projectDeploymentCount: 1,
    purpose: "Organize note collections",
    requirements: [],
    tags: ["notes"],
    upgradeAvailable: false,
  },
];

const page: SkillPage = { facets: { tags: ["documents", "notes", "pdf"] }, items: rows, page: 2, pageSize: 10, total: 23 };
const allColumnIds = [
  "select",
  "name",
  "purpose",
  "tags",
  "lifecycle",
  "deployments",
  "version",
  "security",
  "original_description",
  "translated_description",
  "source",
  "ownership",
  "license",
  "invocation",
  "requirements",
] as const;

async function renderTable(props: Partial<SkillTableProps> = {}) {
  const i18n = await createSkillHubI18n(["en-US"]);
  render(
    <I18nextProvider i18n={i18n}>
      <SkillTable
        onOpenSkill={vi.fn()}
        onPreferencesChange={vi.fn()}
        onQueryChange={vi.fn()}
        onSelectionChange={vi.fn()}
        page={page}
        preferences={DEFAULT_TABLE_PREFERENCES}
        query={{ ...DEFAULT_SKILL_QUERY, page: 2, pageSize: 10 }}
        selection={{ kind: "none" }}
        {...props}
      />
    </I18nextProvider>,
  );
}

it("uses compact density and keeps checkbox clicks separate from row opening", async () => {
  const onOpenSkill = vi.fn();
  const onSelectionChange = vi.fn();
  await renderTable({ onOpenSkill, onSelectionChange });

  expect(screen.getByRole("table")).toHaveAttribute("data-density", "compact");
  fireEvent.click(screen.getByRole("checkbox", { name: "Select PDF Reader" }));
  expect(onSelectionChange).toHaveBeenCalled();
  expect(onOpenSkill).not.toHaveBeenCalled();
  const nameCell = screen.getByText("PDF Reader").closest("td");
  if (!nameCell) throw new Error("Expected the PDF Reader name cell");
  expect(within(nameCell).getByText("Alias:")).toBeVisible();
  expect(within(nameCell).getByText("reader")).toBeVisible();
  fireEvent.click(nameCell);
  expect(onOpenSkill).toHaveBeenCalledWith("skill-pdf", expect.any(HTMLElement));
});

it("opens a focused row with Enter and emits manual sort and pagination", async () => {
  const onOpenSkill = vi.fn();
  const onQueryChange = vi.fn();
  await renderTable({ onOpenSkill, onQueryChange });

  fireEvent.keyDown(screen.getByRole("row", { name: /PDF Reader/ }), { key: "Enter" });
  expect(onOpenSkill).toHaveBeenCalledWith("skill-pdf", expect.any(HTMLElement));
  fireEvent.click(screen.getByRole("button", { name: "Sort by name" }));
  expect(onQueryChange).toHaveBeenCalledWith(
    expect.objectContaining({ page: 1, sort: { column: "name", direction: "desc" } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  expect(onQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
});

it("does not allow the select or name columns to be hidden", async () => {
  const onPreferencesChange = vi.fn();
  await renderTable({ onPreferencesChange });

  fireEvent.click(screen.getByRole("button", { name: "Columns and density" }));
  expect(screen.getByRole("checkbox", { name: "Selection" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "Name" })).toBeDisabled();
  const versionColumn = screen.getByRole("listitem", { name: "Version" });
  const deploymentsColumn = screen.getByRole("listitem", { name: "Deployments" });
  fireEvent.dragStart(versionColumn);
  fireEvent.dragOver(deploymentsColumn);
  fireEvent.drop(deploymentsColumn);
  const next = onPreferencesChange.mock.calls.at(-1)?.[0];
  expect(next.columnOrder.indexOf("version")).toBeLessThan(next.columnOrder.indexOf("deployments"));
});

it("offers all supported page sizes and reports the current page range", async () => {
  await renderTable();

  const pageSize = screen.getByRole("combobox", { name: "Page size" });
  expect(within(pageSize).getAllByRole("option").map((option) => option.textContent)).toEqual(["10", "25", "50", "100"]);
  expect(screen.getByText("11–20 of 23")).toBeVisible();
  expect(screen.getByRole("button", { name: "Previous page" })).not.toBeDisabled();
  expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled();
});

it("reports basic and AI security checks separately with neutral unavailable states", async () => {
  await renderTable();

  const pdfRow = screen.getByRole("row", { name: /PDF Reader/ });
  expect(within(pdfRow).getByText("Basic: Passed")).toBeVisible();
  expect(within(pdfRow).getByText("AI: Unavailable")).toBeVisible();
  expect(within(pdfRow).getByText("1 pending")).toBeVisible();
  const notesRow = screen.getByRole("row", { name: /Notes Helper/ });
  expect(within(notesRow).getByText("AI: Not run")).toBeVisible();
  expect(within(notesRow).getByText("2 high risk")).toBeVisible();
});

it("sets aria-sort on the actively sorted name header and resets pages when page size changes", async () => {
  const onQueryChange = vi.fn();
  await renderTable({ onQueryChange });

  expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "ascending");
  fireEvent.change(screen.getByRole("combobox", { name: "Page size" }), { target: { value: "50" } });
  expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 50 }));
});

it("selects only the current page from the header checkbox", async () => {
  const onSelectionChange = vi.fn();
  await renderTable({ onSelectionChange });

  fireEvent.click(screen.getByRole("checkbox", { name: "Select current page" }));

  expect(onSelectionChange).toHaveBeenCalledWith({
    kind: "explicit",
    skillIds: ["skill-notes", "skill-pdf"],
  });
});

it("keeps all-filtered scope when the header excludes the current page", async () => {
  const onSelectionChange = vi.fn();
  const selection = {
    excludedSkillIds: ["skill-other-page"],
    filter: {
      filters: { ...DEFAULT_SKILL_QUERY.filters, tags: ["documents"] },
      text: "reader",
    },
    filterKey: "filter:reader",
    kind: "all_filtered" as const,
    total: 80,
  };
  await renderTable({ onSelectionChange, selection });

  fireEvent.click(screen.getByRole("checkbox", { name: "Select current page" }));

  expect(onSelectionChange).toHaveBeenCalledWith({
    ...selection,
    excludedSkillIds: ["skill-notes", "skill-other-page", "skill-pdf"],
  });
});

it("keeps other-page exclusions when the header reselects the current page", async () => {
  const onSelectionChange = vi.fn();
  const selection = {
    excludedSkillIds: ["skill-notes", "skill-other-page", "skill-pdf"],
    filter: { filters: DEFAULT_SKILL_QUERY.filters, text: "" },
    filterKey: "filter:all",
    kind: "all_filtered" as const,
    total: 23,
  };
  await renderTable({ onSelectionChange, selection });

  fireEvent.click(screen.getByRole("checkbox", { name: "Select current page" }));

  expect(onSelectionChange).toHaveBeenCalledWith({
    ...selection,
    excludedSkillIds: ["skill-other-page"],
  });
});

it("excludes an all-filtered selection without opening the row", async () => {
  const onOpenSkill = vi.fn();
  const onSelectionChange = vi.fn();
  const selection = {
    excludedSkillIds: [],
    filter: { filters: DEFAULT_SKILL_QUERY.filters, text: "" },
    filterKey: "",
    kind: "all_filtered" as const,
    total: 23,
  };
  await renderTable({ onOpenSkill, onSelectionChange, selection });

  fireEvent.click(screen.getByRole("checkbox", { name: "Select PDF Reader" }));

  expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({
    excludedSkillIds: ["skill-pdf"],
    kind: "all_filtered",
  }));
  expect(onOpenSkill).not.toHaveBeenCalled();
});

it("emits controlled visibility and density preference updates", async () => {
  const onPreferencesChange = vi.fn();
  await renderTable({ onPreferencesChange });

  fireEvent.click(screen.getByRole("button", { name: "Columns and density" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Purpose" }));
  expect(onPreferencesChange).toHaveBeenLastCalledWith(expect.objectContaining({
    visibleColumns: expect.not.arrayContaining(["purpose"]),
  }));
  fireEvent.click(screen.getByRole("radio", { name: "Standard" }));
  expect(onPreferencesChange).toHaveBeenLastCalledWith(expect.objectContaining({ density: "standard" }));
});

it("keeps row checkbox keyboard activation isolated from row opening", async () => {
  const onOpenSkill = vi.fn();
  await renderTable({ onOpenSkill });

  fireEvent.keyDown(screen.getByRole("checkbox", { name: "Select PDF Reader" }), { key: "Enter" });

  expect(onOpenSkill).not.toHaveBeenCalled();
});

it("keeps the selection cell semantic while using compact inline cell content", async () => {
  await renderTable();

  const pdfRow = screen.getByRole("row", { name: /PDF Reader/ });
  const selectionCell = pdfRow.querySelector("td");
  const name = within(pdfRow).getByText("PDF Reader").closest(".sh-skill-table__name");
  const security = within(pdfRow).getByText("Basic: Passed").closest(".sh-skill-table__security");
  expect(selectionCell).toHaveRole("cell");
  expect(selectionCell).not.toHaveAttribute("role", "presentation");
  expect(name).toHaveClass("sh-skill-table__inline");
  expect(security).toHaveClass("sh-skill-table__inline");
  expect(getComputedStyle(name as HTMLElement).display).toBe("flex");
  expect(getComputedStyle(name as HTMLElement).whiteSpace).toBe("nowrap");
  expect(getComputedStyle(security as HTMLElement).display).toBe("flex");
  expect(getComputedStyle(screen.getByRole("table")).getPropertyValue("--skill-row-height")).toBe("2.375rem");
});

it("defines coarse-pointer targets for every compact table interaction", async () => {
  await renderTable();

  const headerCheckbox = screen.getByRole("checkbox", { name: "Select current page" });
  const rowCheckbox = screen.getByRole("checkbox", { name: "Select PDF Reader" });
  expect(headerCheckbox.closest("label")).toHaveClass("sh-skill-table__checkbox-target");
  expect(rowCheckbox.closest("label")).toHaveClass("sh-skill-table__checkbox-target");

  const coarsePointerCss = baseCss.slice(baseCss.lastIndexOf("@media (pointer: coarse)"));
  expect(coarsePointerCss).toMatch(
    /\.sh-skill-table\[data-density="compact"\][^{]*\{[^}]*--skill-row-height:\s*2\.75rem/,
  );
  expect(coarsePointerCss).toMatch(
    /\.sh-skill-table__checkbox-target[\s\S]*\.sh-skill-table__sort[\s\S]*min-height:\s*2\.75rem/,
  );
});

it("gives every visible column a semantic width contract for narrow overflow", async () => {
  await renderTable({
    preferences: {
      ...DEFAULT_TABLE_PREFERENCES,
      visibleColumns: [...allColumnIds],
    },
  });

  const headers = screen.getAllByRole("columnheader");
  expect(headers).toHaveLength(allColumnIds.length);
  expect(headers.map((header) => header.getAttribute("data-column"))).toEqual(allColumnIds);

  const pdfCells = within(screen.getByRole("row", { name: /PDF Reader/ })).getAllByRole("cell");
  expect(pdfCells.map((cell) => cell.getAttribute("data-column"))).toEqual(allColumnIds);
  for (const column of allColumnIds) {
    expect(baseCss).toContain(`[data-column="${column}"]`);
  }
  expect(baseCss).not.toMatch(/\.sh-skill-table (?:th|td):nth-child/);

  const tableBaseIndex = baseCss.indexOf(".sh-skill-table {");
  const narrowIndex = baseCss.lastIndexOf("@media (max-width: 56rem)");
  expect(narrowIndex).toBeGreaterThan(tableBaseIndex);
  expect(baseCss.slice(narrowIndex)).toMatch(
    /\.sh-skill-table\s*\{[^}]*width:\s*max-content[^}]*min-width:\s*max-content/,
  );
});

it("disables pagination controls at the first and last pages", async () => {
  await renderTable({ page: { ...page, page: 1 }, query: { ...DEFAULT_SKILL_QUERY, page: 1, pageSize: 10 } });
  expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled();
});

it("disables the next page control at the final page", async () => {
  await renderTable({ page: { ...page, page: 3 }, query: { ...DEFAULT_SKILL_QUERY, page: 3, pageSize: 10 } });
  expect(screen.getByRole("button", { name: "Previous page" })).not.toBeDisabled();
  expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
});
