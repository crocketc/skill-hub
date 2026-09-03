import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { skillHubI18n } from "../../i18n";
import type { BackupFacade } from "./api";
import { DataProtectionPage } from "./DataProtectionPage";

function renderPage(facade: BackupFacade) {
  return render(
    <I18nextProvider i18n={skillHubI18n}>
      <DataProtectionPage facade={facade} />
    </I18nextProvider>,
  );
}

function createFacade(): BackupFacade {
  return {
    prepareBackup: vi.fn(),
    createBackup: vi.fn(),
    verifyBackup: vi.fn().mockResolvedValue(undefined),
    prepareRestore: vi.fn().mockResolvedValue({
      format_version: 1,
      skills: 2,
      deployments_requiring_rediscovery: 1,
      conflicts: [{ skill_id: "skill-1", kind: "existing_skill", detail: "Already exists" }],
    }),
    commitRestore: vi.fn().mockResolvedValue({ skills_restored: 1, skills_skipped: 1, deployments_requiring_rediscovery: 1 }),
    prepareExport: vi.fn().mockResolvedValue({ selection: { combination: "combo-1" }, versions: "current", skills: [], sensitive_items: [{ skill_id: "skill-2", reason: "secret" }] }),
    createExport: vi.fn().mockResolvedValue({ path: "C:/export.skillhub", skills_exported: 2 }),
  };
}

describe("DataProtectionPage", () => {
  it("requires restore conflict decisions before committing and shows the result", async () => {
    const facade = createFacade();
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Backup package path"), { target: { value: "C:/backup.skillhub" } });
    fireEvent.click(screen.getByRole("button", { name: "Review restore" }));
    expect(await screen.findByText("Already exists")).toBeVisible();
    const commit = screen.getByRole("button", { name: "Restore backup" });
    expect(commit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Decision for skill-1"), { target: { value: "overwrite" } });
    fireEvent.click(commit);
    await waitFor(() => expect(facade.commitRestore).toHaveBeenCalledWith("C:/backup.skillhub", [{ skill_id: "skill-1", decision: "overwrite" }]));
    expect(await screen.findByText(/Restored 1 skills/)).toBeVisible();
  });

  it("preflights and creates a combination export after sensitive-content decisions", async () => {
    const facade = createFacade();
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Combination ID"), { target: { value: "combo-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    expect(await screen.findByText(/skill-2/)).toBeVisible();
    const create = screen.getByRole("button", { name: "Create export" });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Export decision for skill-2"), { target: { value: "include_and_mark" } });
    fireEvent.click(create);
    await waitFor(() => expect(facade.createExport).toHaveBeenCalledWith({ selection: { combination: "combo-1" }, versions: "current", skills: [] }, [{ skill_id: "skill-2", decision: "include_and_mark" }]));
    expect(await screen.findByText(/C:\/export.skillhub/)).toBeVisible();
  });
});
