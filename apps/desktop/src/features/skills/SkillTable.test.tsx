import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
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
  fireEvent.click(screen.getByRole("cell", { name: /PDF Reader/ }));
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
    expect.objectContaining({ page: 1, sort: { column: "name", direction: "asc" } }),
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
  fireEvent.click(screen.getByRole("button", { name: "Move version before deployments" }));
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
