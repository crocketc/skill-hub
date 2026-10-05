import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { skillHubI18n } from "../../i18n";
import { createOperationTracker } from "../../platform/operationTracker";
import type { DeploymentRecord, ExportPreview, VersionResult } from "../../api/bindings";
import type { BackupFacade } from "./api";
import { DataProtectionPage } from "./DataProtectionPage";

function deploymentRecord(id: string, skillId: string, state: DeploymentRecord["state"] = "deployed"): DeploymentRecord {
  return {
    id,
    skill_id: skillId,
    version_id: `${skillId}-v1`,
    target_id: `target-${id}`,
    state,
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
  picker?: { pickDirectory: () => Promise<string | null> };
  opener?: { openDirectory: (path: string) => Promise<void> };
}

function renderPage(facade: BackupFacade, options: RenderPageOptions = {}, tracker = createOperationTracker()) {
  return render(
    <I18nextProvider i18n={skillHubI18n}>
      <MemoryRouter initialEntries={[{ pathname: "/settings/data-protection", state: options.state }]}>
        <DataProtectionPage facade={facade} directoryOpener={options.opener} directoryPicker={options.picker} tracker={tracker} />
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
    // K3 预览三件套：prepare 返回 ExportPreview 载荷；create 只收 preview_id。
    prepareExport: vi.fn().mockResolvedValue(exportPreviewFixture()),
    createExport: vi.fn().mockResolvedValue({ path: "C:/export.skillhub", skills_exported: 2 }),
    listDeployments: vi.fn().mockResolvedValue([]),
    listVersions: vi.fn().mockResolvedValue([]),
    prepareUninstall: vi.fn(),
    applyUninstallDecision: vi.fn(),
  };
}

function exportPreviewFixture(overrides: Partial<ExportPreview> = {}): ExportPreview {
  return {
    selection: { skills: ["skill-1", "skill-2"] },
    versions: "current",
    skills: [
      { skill_id: "skill-1", version_id: "skill-1-v1", display_name: "PDF Reader" },
      { skill_id: "skill-2", version_id: "skill-2-v2", display_name: "DOCX Writer" },
    ],
    sensitive_items: [
      { skill_id: "skill-2", version_id: "skill-2-v2", path: "assets/.env", reason: "sensitive_filename" },
    ],
    preview_id: "op-export-preview-1",
    expires_at: "2999-01-01T00:00:00Z",
    confirmation_fingerprint: "fp-1",
    ...overrides,
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

  it("reports the restore commit to the unified tracker with progress and an honest summary", async () => {
    const facade = createFacade();
    const tracker = createOperationTracker();
    renderPage(facade, {}, tracker);
    fireEvent.change(screen.getByLabelText("Backup package path"), { target: { value: "C:/backup.skillhub" } });
    fireEvent.click(screen.getByRole("button", { name: "Review restore" }));
    expect(await screen.findByText("Already exists")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Decision for skill-1"), { target: { value: "overwrite" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore backup" }));

    expect(await screen.findByText(/Restored 1 skills/)).toBeVisible();
    const [operation] = tracker.getSnapshot();
    expect(operation.kind).toBe("restore");
    expect(operation.status).toBe("success");
    // 汇总来自 RestoreResult 的真实计数：恢复/跳过分开统计，不伪造失败。
    expect(operation.resultSummary).toEqual({ succeeded: 1, failed: 0, skipped: 1 });
    expect(operation.hasKnownTotal).toBe(true);
  });

  it("preflights and creates a selected-skill export after sensitive-content decisions", async () => {
    const facade = createFacade();
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1, skill-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    expect(await screen.findByLabelText("Export decision for DOCX Writer")).toBeVisible();
    const create = screen.getByRole("button", { name: "Create export" });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Export decision for DOCX Writer"), { target: { value: "include_and_mark" } });
    fireEvent.click(create);
    // K3：create 只携带预览 id 与敏感决定，实际输入由后端从预览快照取。
    await waitFor(() => expect(facade.createExport).toHaveBeenCalledWith("op-export-preview-1", [{ skill_id: "skill-2", decision: "include_and_mark" }]));
    expect(await screen.findByText(/C:\/export.skillhub/)).toBeVisible();
  });

  // K3-B 预览冻结（契约 §K3-1）：preview_id 三件套绑定主体/版本/格式/目录，
  // 任一输入改变即作废旧预览——提示重新预览，且不得拿旧预览创建。
  it("invalidates the export preview when a bound choice changes after review", async () => {
    const facade = createFacade();
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    expect(await screen.findByLabelText("Export decision for DOCX Writer")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Export decision for DOCX Writer"), { target: { value: "include_and_mark" } });
    expect(screen.getByRole("button", { name: "Create export" })).toBeEnabled();

    // 修改任一绑定选择（此处为格式）：旧预览立即作废。
    fireEvent.change(screen.getByLabelText("Export format"), { target: { value: "zip" } });
    expect(screen.getByText(/no longer valid/)).toBeVisible();
    // 不得拿旧预览直接创建：创建入口随旧预览一起撤下。
    expect(screen.queryByRole("button", { name: "Create export" })).not.toBeInTheDocument();
    expect(facade.createExport).not.toHaveBeenCalled();

    // 重新预览后恢复常规流程：新预览有效，创建可用。
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    expect(await screen.findByLabelText("Export decision for DOCX Writer")).toBeVisible();
    expect(screen.queryByText(/no longer valid/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Export decision for DOCX Writer"), { target: { value: "include_and_mark" } });
    fireEvent.click(screen.getByRole("button", { name: "Create export" }));
    await waitFor(() => expect(facade.createExport).toHaveBeenCalledTimes(1));
  });

  // K3 预览过期（契约 §2）：expires_at 已过 → UI 撤下创建入口并要求重新
  // 预览，不得静默重试提交。
  it("withdraws the create entry and asks for a new preview once the preview expires", async () => {
    const facade = createFacade();
    facade.prepareExport = vi.fn()
      .mockResolvedValueOnce(exportPreviewFixture({ expires_at: "2000-01-01T00:00:00Z" }))
      .mockResolvedValueOnce(exportPreviewFixture());
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));

    // 过期提示可见，审阅面板与创建入口一并撤下——唯一的路是重新预览。
    expect(await screen.findByText(/has expired/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create export" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Export decision for DOCX Writer")).not.toBeInTheDocument();
    expect(facade.createExport).not.toHaveBeenCalled();

    // 重新预览得到未过期预览后流程恢复。
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    expect(await screen.findByLabelText("Export decision for DOCX Writer")).toBeVisible();
    expect(screen.queryByText(/has expired/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Export decision for DOCX Writer"), { target: { value: "include_and_mark" } });
    fireEvent.click(screen.getByRole("button", { name: "Create export" }));
    await waitFor(() => expect(facade.createExport).toHaveBeenCalledWith("op-export-preview-1", [{ skill_id: "skill-2", decision: "include_and_mark" }]));
  });

  // 裁决：导出敏感项决定只提供真实可执行的两个决定（exclude/include）。
  // K3 存储层对 resolve_first 诚实拒绝（BackupExportDecisionRequired），
  // 下拉里不得提供注定失败的决定；「先去解决冲突」入口属后续批次。
  it("offers only the executable export decisions for scanned sensitive items", async () => {
    const facade = createFacade();
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    const select = await screen.findByLabelText("Export decision for DOCX Writer");

    const values = [...select.querySelectorAll("option")].map((option) => option.value);
    expect(values).toEqual(["", "exclude_skill", "include_and_mark"]);
    // 展示文案同样不得再把「先去解决冲突」渲染成可选项。
    const labels = [...select.querySelectorAll("option")].map((option) => option.textContent);
    expect(labels.join(" ")).not.toMatch(/resolve|resolve first/i);
  });

  // K3 重试语义：创建被拒不消耗预览——补齐/修正后同一 preview_id 可直接重试，
  // 无需重新预览（prepare 只发生一次）。
  it("keeps the preview usable so a rejected create can retry on the same preview id", async () => {
    const facade = createFacade();
    facade.createExport = vi.fn()
      .mockRejectedValueOnce(new Error("export storage unavailable"))
      .mockResolvedValueOnce({ path: "C:/export.skillhub", skills_exported: 2 });
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    await screen.findByLabelText("Export decision for DOCX Writer");
    fireEvent.change(screen.getByLabelText("Export decision for DOCX Writer"), { target: { value: "include_and_mark" } });
    fireEvent.click(screen.getByRole("button", { name: "Create export" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("export storage unavailable");
    // 预览未被消耗：审阅面板与创建入口仍在，可直接重试。
    expect(screen.getByRole("button", { name: "Create export" })).toBeEnabled();
    expect(screen.queryByText(/no longer valid|has expired/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create export" }));
    // 同一 preview_id 重试，不重新预览。
    await waitFor(() => expect(facade.createExport).toHaveBeenNthCalledWith(2, "op-export-preview-1", [{ skill_id: "skill-2", decision: "include_and_mark" }]));
    expect(await screen.findByText(/C:\/export.skillhub/)).toBeVisible();
    expect(facade.prepareExport).toHaveBeenCalledTimes(1);
  });


  // K3-B 扫描结果呈现（契约 §K3 DTO 落点）：敏感项为
  // ExportSensitiveItem { skill_id, version_id, path, reason }，按
  // 「文件 + 可读原因」呈现；Skill 用预览载荷里的显示名，不裸露
  // skill_id/version_id 内部标识；内部枚举映射为用户事实文案。
  it("renders scanned sensitive files with their paths and user-facing reasons", async () => {
    const facade = createFacade();
    facade.prepareExport = vi.fn().mockResolvedValue(exportPreviewFixture({
      selection: { skills: ["skill-1"] },
      skills: [{ skill_id: "skill-1", version_id: "skill-1-v2", display_name: "PDF Reader" }],
      sensitive_items: [
        { skill_id: "skill-1", version_id: "skill-1-v2", path: "assets/.env", reason: "sensitive_filename" },
        { skill_id: "skill-1", version_id: "skill-1-v2", path: "scripts/run.py", reason: "possible_plaintext_credential" },
      ],
    }));
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));

    expect(await screen.findByText("assets/.env")).toBeVisible();
    expect(screen.getByText("scripts/run.py")).toBeVisible();
    // 显示名替代内部 skill_id：同一扫描项的处置下拉也用显示名命名。
    // 两个扫描项同属一个 Skill，显示名成对出现。
    expect(screen.getAllByText("PDF Reader")).toHaveLength(2);
    // 决定下拉按显示名命名；同 Skill 多文件共享同一处理决定（决定按 Skill 提交）。
    expect(screen.getAllByLabelText("Export decision for PDF Reader")).toHaveLength(2);
    expect(screen.queryByText("skill-1")).not.toBeInTheDocument();
    expect(screen.queryByText("skill-1-v2")).not.toBeInTheDocument();
    // 内部枚举映射为用户事实文案：sensitive_filename 说文件名可疑，
    // possible_plaintext_credential 说内容可能含明文凭证；枚举原文不出现。
    expect(screen.getByText(/file name/i)).toBeVisible();
    expect(screen.getByText(/plaintext key or token/i)).toBeVisible();
    expect(screen.queryByText("sensitive_filename")).not.toBeInTheDocument();
    expect(screen.queryByText("possible_plaintext_credential")).not.toBeInTheDocument();
  });

  // K3-B 故障矩阵（契约 §K3-3）：创建收到过期/不存在预览类错误时映射为
  // 「重新预览」指引；导出失败必须可见，不得伪装成功。
  it("maps an expired export preview rejection to the re-preview guidance", async () => {
    const facade = createFacade();
    facade.createExport = vi.fn().mockRejectedValue({
      code: "object.not_found",
      severity: "error",
      params: { field: "prepared_export" },
      actions: [],
    });
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    await screen.findByLabelText("Export decision for DOCX Writer");
    fireEvent.change(screen.getByLabelText("Export decision for DOCX Writer"), { target: { value: "include_and_mark" } });
    fireEvent.click(screen.getByRole("button", { name: "Create export" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/has expired or is missing/);
    // 失败可见：不得出现成功结果文案。
    expect(screen.queryByText(/Export created at/)).not.toBeInTheDocument();
  });

  it("lets the user export as a single zip archive", async () => {
    const facade = createFacade();
    renderPage(facade);
    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1" } });
    fireEvent.change(screen.getByLabelText("Export format"), { target: { value: "zip" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    await waitFor(() => expect(facade.prepareExport).toHaveBeenCalledWith(expect.objectContaining({ selection: { skills: ["skill-1"] }, versions: "current", format: "zip", output_dir: null })));
    expect(await screen.findByLabelText("Export decision for DOCX Writer")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Export decision for DOCX Writer"), { target: { value: "include_and_mark" } });
    fireEvent.click(screen.getByRole("button", { name: "Create export" }));
    await waitFor(() => expect(facade.createExport).toHaveBeenCalledWith("op-export-preview-1", expect.anything()));
    expect(await screen.findByText(/C:\/export.skillhub/)).toBeVisible();
  });

  it("passes the chosen output directory through to the export creation", async () => {
    const facade = createFacade();
    const picker = { pickDirectory: vi.fn().mockResolvedValue("C:/chosen/exports") };
    renderPage(facade, { picker });

    fireEvent.click(screen.getByRole("button", { name: "Choose output directory" }));
    expect(await screen.findByText(/C:\/chosen\/exports/)).toBeVisible();
    expect(picker.pickDirectory).toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    await screen.findByLabelText("Export decision for DOCX Writer");
    // K3：输出目录在 prepare 阶段进入预览绑定（create 载荷只有 preview_id）。
    await waitFor(() =>
      expect(facade.prepareExport).toHaveBeenCalledWith(
        expect.objectContaining({ output_dir: "C:/chosen/exports" }),
      ),
    );
    fireEvent.change(screen.getByLabelText("Export decision for DOCX Writer"), { target: { value: "include_and_mark" } });
    fireEvent.click(screen.getByRole("button", { name: "Create export" }));
    await waitFor(() =>
      expect(facade.createExport).toHaveBeenCalledWith(
        "op-export-preview-1",
        expect.anything(),
      ),
    );
  });

  it("omits the output directory when the user cancels the picker", async () => {
    const facade = createFacade();
    const picker = { pickDirectory: vi.fn().mockResolvedValue(null) };
    renderPage(facade, { picker });

    fireEvent.click(screen.getByRole("button", { name: "Choose output directory" }));
    await waitFor(() => expect(picker.pickDirectory).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review export" }));
    await waitFor(() =>
      expect(facade.prepareExport).toHaveBeenCalledWith(
        expect.objectContaining({ output_dir: null }),
      ),
    );
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
    await waitFor(() => expect(facade.prepareExport).toHaveBeenCalledWith(expect.objectContaining({ selection: { skills: ["skill-1", "skill-2"] }, versions: "current", format: "folder", output_dir: null })));
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

    fireEvent.click(await screen.findByLabelText("Select deployment relation dep-1"));
    fireEvent.click(screen.getByLabelText("Select deployment relation dep-2"));
    expect(preview).toBeEnabled();
    fireEvent.click(preview);

    expect(await screen.findByText("2 deployment relations are affected.")).toBeVisible();
    expect(screen.getByText("The central Skill library will not be preserved.")).toBeVisible();

    const undeployAll = screen.getByLabelText("Remove all selected copies from their targets");
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

    fireEvent.click(await screen.findByLabelText("Select deployment relation dep-1"));
    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
    const backup = await screen.findByLabelText("Back up selected data");
    fireEvent.click(backup);
    fireEvent.click(screen.getByLabelText("Remove all selected copies from their targets"));
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

    fireEvent.click(await screen.findByLabelText("Select deployment relation dep-1"));
    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("uninstall preflight failed");
    expect(screen.queryByText("1 deployment relations are affected.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply selected actions" })).toBeDisabled();
  });

  it("reports failures from loading the deployment list", async () => {
    const facade = createFacade();
    facade.listDeployments = vi.fn().mockRejectedValue(new Error("deployments unavailable"));
    renderPage(facade);

    expect(await screen.findByRole("alert")).toHaveTextContent("deployments unavailable");
    expect(screen.queryByLabelText("Select deployment relation dep-1")).not.toBeInTheDocument();
  });

  /**
   * 退出管理列出的是**仍然存在**的部署关系。`removed` 行只是账目历史，磁盘上
   * 已经没有这个副本，列出来会让用户去处置一个并不存在的关系；状态也要说人话，
   * 不能把裸枚举值直接显示出来。
   */
  it("lists only deployments that still exist and names their state in the UI language", async () => {
    const facade = createFacade();
    facade.listDeployments = vi.fn().mockResolvedValue([
      deploymentRecord("dep-live", "skill-live"),
      deploymentRecord("dep-gone", "skill-gone", "removed"),
    ]);
    renderPage(facade);

    expect(await screen.findByLabelText("Select deployment relation dep-live")).toBeVisible();
    expect(screen.queryByLabelText("Select deployment relation dep-gone")).not.toBeInTheDocument();
    expect(screen.getByText(/dep-live: skill-live → target-dep-live \(deployed\)/)).toBeVisible();
  });
});

// W1-1：备份不含未保存编辑草稿——说明区常态可见（备份前），完成 status 行复核同一提示。
it("states before and after a rolling backup that unsaved edit drafts are not included", async () => {
  const user = userEvent.setup();
  const runRollingBackup = vi.fn(async () => ({ retained: 3, removed: 2 }));
  const facade = {
    ...createFacade(),
    runRollingBackup,
  };
  renderPage(facade);

  // 备份前：滚动备份区块的分区注记常态可见。
  expect(screen.getByText(/Backups do not include unsaved edit drafts/)).toBeVisible();

  await user.click(await screen.findByRole("button", { name: "Run rolling backup" }));
  expect(await screen.findByText(/3 kept/)).toBeVisible();
  // 完成后：提示在分区注记与完成 status 行各出现一次。
  expect(screen.getAllByText(/Backups do not include unsaved edit drafts/)).toHaveLength(2);
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

it("exports every historical version when the history scope is chosen", async () => {
  const facade = createFacade();
  facade.listVersions = vi.fn(async () => [
    versionResult("skill-1", "v1", false),
    versionResult("skill-1", "v2", true),
  ]);
  renderPage(facade);
  fireEvent.change(screen.getByLabelText("Skill IDs"), { target: { value: "skill-1" } });
  fireEvent.change(screen.getByLabelText("Version scope"), { target: { value: "history" } });
  fireEvent.click(screen.getByRole("button", { name: "Review export" }));

  await waitFor(() =>
    expect(facade.prepareExport).toHaveBeenCalledWith(
      expect.objectContaining({
        versions: { history: ["v1", "v2"] },
      }),
    ),
  );
  // mock 预览固定含 DOCX Writer 的敏感项：先设置决策再提交。
  fireEvent.change(screen.getByLabelText("Export decision for DOCX Writer"), { target: { value: "include_and_mark" } });
  fireEvent.click(screen.getByRole("button", { name: "Create export" }));
  await waitFor(() => expect(facade.createExport).toHaveBeenCalledWith("op-export-preview-1", [{ skill_id: "skill-2", decision: "include_and_mark" }]));

});

it("shows the library path and opens it through the native opener", async () => {
  const facade = createFacade();
  facade.libraryPath = vi.fn(async () => "C:/Users/demo/SkillHub");
  const opener = { openDirectory: vi.fn(async () => undefined) };
  renderPage(facade, { opener });

  // DEV-5：展示层统一斜杠风格；底层 opener 仍收到原始路径。
  expect(await screen.findByText("C:\\Users\\demo\\SkillHub")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open library folder" }));
  await waitFor(() => expect(opener.openDirectory).toHaveBeenCalledWith("C:/Users/demo/SkillHub"));
});

