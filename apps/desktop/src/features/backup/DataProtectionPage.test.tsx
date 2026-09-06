import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { skillHubI18n } from "../../i18n";
import type { DeploymentRecord, VersionResult } from "../../api/bindings";
import type { BackupFacade } from "./api";
import { DataProtectionPage } from "./DataProtectionPage";

function deploymentRecord(id: string, skillId: string): DeploymentRecord {
  return {
    id,
    skill_id: skillId,
    version_id: `${skillId}-v1`,
    target_id: `target-${id}`,
    state: "deployed",
    mode: "symbolic_link",
    managed: true,
    runtime_name: skillId,
    expected_hash: "hash",
    observed_hash: "hash",
  };
}

function versionResult(skillId: string, versionId: string, current: boolean): VersionResult {
  return { version_id: versionId, skill_id: skillId, current, file_count: 1, added: 0, changed: 0, removed: 0 };
}

interface RenderPageOptions {
  state?: unknown;
}

function renderPage(facade: BackupFacade, options: RenderPageOptions = {}) {
  return render(
    <I18nextProvider i18n={skillHubI18n}>
      <MemoryRouter initialEntries={[{ pathname: "/settings/data-protection", state: options.state }]}>
        <DataProtectionPage facade={facade} />
      </MemoryRouter>
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
    listDeployments: vi.fn().mockResolvedValue([]),
    listVersions: vi.fn().mockResolvedValue([]),
    prepareUninstall: vi.fn(),
    applyUninstallDecision: vi.fn(),
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

  it("preflights and creates a selected-skill export after sensitive-content decisions", async () => {
    const facade = createFacade();
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1, skill-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    expect(await screen.findByText(/skill-2/)).toBeVisible();
    const create = screen.getByRole("button", { name: "Create export" });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Export decision for skill-2"), { target: { value: "include_and_mark" } });
    fireEvent.click(create);
    await waitFor(() => expect(facade.createExport).toHaveBeenCalledWith({ selection: { skills: ["skill-1", "skill-2"] }, versions: "current", skills: [], format: "folder" }, [{ skill_id: "skill-2", decision: "include_and_mark" }]));
    expect(await screen.findByText(/C:\/export.skillhub/)).toBeVisible();
  });

  it("lets the user export as a single zip archive", async () => {
    const facade = createFacade();
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1" } });
    fireEvent.change(screen.getByLabelText("Export format"), { target: { value: "zip" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    await waitFor(() => expect(facade.prepareExport).toHaveBeenCalledWith({ selection: { skills: ["skill-1"] }, versions: "current", skills: [], format: "zip" }));
    expect(await screen.findByText(/skill-2/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Export decision for skill-2"), { target: { value: "include_and_mark" } });
    fireEvent.click(screen.getByRole("button", { name: "Create export" }));
    await waitFor(() => expect(facade.createExport).toHaveBeenCalledWith(expect.objectContaining({ format: "zip" }), expect.anything()));
    expect(await screen.findByText(/C:\/export.skillhub/)).toBeVisible();
  });

  it("prefills the export selection from library navigation state and marks readiness per skill", async () => {
    const facade = createFacade();
    facade.listVersions = vi.fn((skillId: string) => {
      if (skillId === "skill-2") {
        return Promise.resolve([versionResult("skill-2", "skill-2-v3", false)]);
      }
      return Promise.resolve([versionResult("skill-1", "skill-1-v2", true)]);
    });
    renderPage(facade, { state: { exportSkillIds: ["skill-1", "skill-2"] } });

    const input = screen.getByLabelText("Skill IDs");
    expect(input).toHaveValue("skill-1, skill-2");
    expect(await screen.findByText("skill-1: Ready to export (current version skill-1-v2)")).toBeVisible();
    expect(await screen.findByText("skill-2: Cannot export: this skill has no current version.")).toBeVisible();
    expect(facade.listVersions).toHaveBeenCalledWith("skill-1");
    expect(facade.listVersions).toHaveBeenCalledWith("skill-2");

    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    await waitFor(() => expect(facade.prepareExport).toHaveBeenCalledWith({ selection: { skills: ["skill-1", "skill-2"] }, versions: "current", skills: [], format: "folder" }));
  });

  it("marks carried-over skills as unexportable when their versions cannot be read", async () => {
    const facade = createFacade();
    facade.listVersions = vi.fn().mockRejectedValue(new Error("version lookup failed"));
    renderPage(facade, { state: { exportSkillIds: ["skill-9"] } });

    expect(screen.getByLabelText("Skill IDs")).toHaveValue("skill-9");
    expect(await screen.findByText("skill-9: Cannot export: version information is unavailable.")).toBeVisible();
  });

  it("previews uninstall impact from selected deployments and applies only the chosen actions", async () => {
    const facade = createFacade();
    facade.listDeployments = vi.fn().mockResolvedValue([
      deploymentRecord("dep-1", "skill-1"),
      deploymentRecord("dep-2", "skill-2"),
    ]);
    facade.prepareUninstall = vi.fn().mockResolvedValue({
      deployments: [deploymentRecord("dep-1", "skill-1"), deploymentRecord("dep-2", "skill-2")],
      actions: ["undeploy_all", "leave_targets_independent", "retain_central_library"],
      preserves_central_library: false,
    });
    facade.applyUninstallDecision = vi.fn().mockResolvedValue({
      operation_id: "op-uninstall",
      phase: "committed",
      message_code: "uninstall.decision_applied",
      error_code: null,
    });
    renderPage(facade);

    const preview = screen.getByRole("button", { name: "Preview impact" });
    expect(preview).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply selected actions" })).toBeDisabled();

    fireEvent.click(await screen.findByLabelText("Select deployment dep-1"));
    fireEvent.click(screen.getByLabelText("Select deployment dep-2"));
    expect(preview).toBeEnabled();
    fireEvent.click(preview);

    expect(await screen.findByText("2 deployments are affected.")).toBeVisible();
    expect(screen.getByText("The central Skill library will not be preserved.")).toBeVisible();

    const undeployAll = screen.getByLabelText("Undeploy all selected deployments");
    const retainLibrary = screen.getByLabelText("Retain the central Skill library");
    expect(undeployAll).not.toBeChecked();
    expect(retainLibrary).not.toBeChecked();
    const apply = screen.getByRole("button", { name: "Apply selected actions" });
    expect(apply).toBeDisabled();

    fireEvent.click(undeployAll);
    fireEvent.click(retainLibrary);
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    await waitFor(() => expect(facade.applyUninstallDecision).toHaveBeenCalledWith(["undeploy_all", "retain_central_library"]));
    expect(await screen.findByText("Uninstall decision applied (committed).")).toBeVisible();
  });

  it("sends the backup action through the uninstall decision when selected", async () => {
    const facade = createFacade();
    facade.listDeployments = vi.fn().mockResolvedValue([deploymentRecord("dep-1", "skill-1")]);
    facade.prepareUninstall = vi.fn().mockResolvedValue({
      deployments: [deploymentRecord("dep-1", "skill-1")],
      actions: ["backup", "undeploy_all", "retain_central_library"],
      preserves_central_library: true,
    });
    facade.applyUninstallDecision = vi.fn().mockResolvedValue({
      operation_id: "op-uninstall",
      phase: "committed",
      message_code: "uninstall.decision_applied_with_backup",
      error_code: null,
    });
    renderPage(facade);

    fireEvent.click(await screen.findByLabelText("Select deployment dep-1"));
    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
    const backup = await screen.findByLabelText("Back up selected data");
    fireEvent.click(backup);
    fireEvent.click(screen.getByLabelText("Undeploy all selected deployments"));
    fireEvent.click(screen.getByRole("button", { name: "Apply selected actions" }));

    await waitFor(() =>
      expect(facade.applyUninstallDecision).toHaveBeenCalledWith(["backup", "undeploy_all"]),
    );
  });

  it("keeps uninstall failures structured instead of faking success", async () => {
    const facade = createFacade();
    facade.listDeployments = vi.fn().mockResolvedValue([deploymentRecord("dep-1", "skill-1")]);
    facade.prepareUninstall = vi.fn().mockRejectedValue(new Error("uninstall preflight failed"));
    renderPage(facade);

    fireEvent.click(await screen.findByLabelText("Select deployment dep-1"));
    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("uninstall preflight failed");
    expect(screen.queryByText("1 deployments are affected.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply selected actions" })).toBeDisabled();
  });

  it("reports failures from loading the deployment list", async () => {
    const facade = createFacade();
    facade.listDeployments = vi.fn().mockRejectedValue(new Error("deployments unavailable"));
    renderPage(facade);

    expect(await screen.findByRole("alert")).toHaveTextContent("deployments unavailable");
    expect(screen.queryByLabelText("Select deployment dep-1")).not.toBeInTheDocument();
  });
});

it("runs a rolling backup with the configured retention policy and reports cleanup", async () => {
  const user = userEvent.setup();
  const runRollingBackup = vi.fn(async () => ({ retained: 3, removed: 2 }));
  const facade = {
    ...createFacade(),
    runRollingBackup,
  };
  renderPage(facade);

  await user.click(await screen.findByRole("button", { name: "Run rolling backup" }));
  await waitFor(() =>
    expect(runRollingBackup).toHaveBeenCalledWith(
      expect.objectContaining({ retention: { max_backups: 3 } }),
    ),
  );
  expect(await screen.findByText(/3 kept/)).toBeVisible();
  expect(screen.getByText(/2 removed/)).toBeVisible();
});

it("displays rolling backup failures without faking success", async () => {
  const user = userEvent.setup();
  const facade = {
    ...createFacade(),
    runRollingBackup: async () => {
      throw new Error("dir not writable");
    },
  };
  renderPage(facade);

  await user.click(await screen.findByRole("button", { name: "Run rolling backup" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("dir not writable");
});
