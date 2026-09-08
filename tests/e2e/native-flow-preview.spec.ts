import { expect, test, type Page } from "@playwright/test";

/**
 * Browser-only IPC harness. It exercises the production routes and facades
 * with deterministic facts; it never touches a real directory, network, or
 * Tauri side effect.
 */
async function installNativePreview(page: Page) {
  await page.addInitScript(() => {
    let callbackId = 0;
    const callbacks = new Map<number, (payload: unknown) => void>();
    const bootstrap = {
      initialization_state: "initialized",
      library_path: "C:\\Preview\\SkillHub",
      onboarding_skipped: false,
      agent_count: 2,
      deployed_count: 4,
      deployment_categories: [
        { dimension: "agent", key: "codex", label_code: "Codex CLI", count: 3 },
        { dimension: "project", key: "aurora", label_code: "Aurora", count: 1 },
      ],
      tag_categories: [{ key: "documents", count: 2 }, { key: "automation", count: 1 }],
      last_scan_at: "2026-09-08T08:00:00Z",
      pending: { by_kind: { security_finding: 1 }, total: 1 },
      project_count: 1,
      recent_operations: [{
        operation_id: "op-import-1",
        kind: "import",
        state: "committed",
        phase: "committed",
        error_code: null,
        created_at: "2026-09-08T08:01:00Z",
      }],
      recovery_state: "clean",
      skill_count: 4,
    };
    const discovery = {
      generation: "preview-1",
      observed_at: "2026-09-08T08:00:00Z",
      instances: [
        { profile_id: "openai", client_id: "codex", kind: "cli" },
        { profile_id: "anthropic", client_id: "claude", kind: "cli" },
      ],
      logical_targets: [
        { id: "codex-target", profile_id: "openai", client_id: "codex", scope: "global", path: "C:/Preview/.agents", marker: "SKILL.md", precedence: "preferred", exists: true, readable: true, writable: true, available: true, physical_id: "codex-physical" },
        { id: "claude-target", profile_id: "anthropic", client_id: "claude", scope: "global", path: "C:/Preview/.claude", marker: "SKILL.md", precedence: "fallback", exists: true, readable: true, writable: true, available: true, physical_id: "claude-physical" },
      ],
      physical_targets: [
        { id: "codex-physical", path: "C:/Preview/.agents", exists: true, readable: true, writable: true },
        { id: "claude-physical", path: "C:/Preview/.claude", exists: true, readable: true, writable: true },
      ],
    };
    const repos = [
      { owner: "anthropics", name: "skills", branch: "main", enabled: true },
      { owner: "ComposioHQ", name: "awesome-claude-skills", branch: "main", enabled: false },
    ];
    const onlinePage = {
      items: [{
        source_id: "skills.sh/anthropics/skills/pdf",
        name: "PDF Reader",
        page_url: "https://github.com/anthropics/skills/tree/main/pdf",
        installs: 1200,
        source: { locator: { https_url: "https://github.com/anthropics/skills", git_url: null } },
      }],
      query: "pdf",
      count: 1,
      search_type: "skills.sh",
      duration_ms: 25,
      cache_max_age_seconds: 60,
    };
    const repoReport = {
      skills: [{ key: "anthropics/skills:pdf", name: "PDF Reader", description: "Read PDFs", directory: "pdf", readme_url: "https://github.com/anthropics/skills/tree/main/pdf", repo_owner: "anthropics", repo_name: "skills", repo_branch: "main" }],
      warnings: [{ owner: "cexll", name: "myclaude", reason: "repo.archive_unavailable" }],
    };
    const lockEntries = [{ name: "PDF Reader", owner: "anthropics", repo: "skills", branch: "main", skill_path: "pdf" }];
    const deploymentTargets = [
      { id: "codex-target", label: "Codex CLI", path: "C:/Preview/.agents", available: true, physical_id: "codex-physical", modes: ["symbolic_link", "managed_copy"] },
      { id: "claude-target", label: "Claude Code", path: "C:/Preview/.claude", available: true, physical_id: "claude-physical", modes: ["managed_copy"] },
      { id: "missing-target", label: "Unavailable target", path: "C:/Preview/missing", available: false, physical_id: "missing-physical", modes: ["managed_copy"] },
    ];
    const deployments = [{ id: "dep-1", skill_id: "pdf-reader", version_id: "v1", target_id: "codex-target", state: "deployed", mode: "symbolic_link", managed: true, runtime_name: "pdf-reader", expected_hash: "hash", observed_hash: "hash" }];
    const skillItems = [
      { skill_id: "pdf-reader", display_name: "PDF Reader", runtime_name: "pdf-reader", original_description: "Read PDFs", translated_description: null, user_note: null, tags: ["documents"], license: "MIT", lifecycle: "Normal", trial_due: null, author: "anthropics", source_kind: "github", source_locator: "anthropics/skills", current_version: "v1", current_version_label: "v1", agent_deployment_count: 1, agent_deployment_target_ids: ["codex-target"], project_deployment_count: 0, basic_check: "passed", ai_check: "not_checked", high_risk_count: 1 },
      { skill_id: "release-notes", display_name: "Release Notes", runtime_name: "release-notes", original_description: "Write release notes", translated_description: null, user_note: null, tags: ["automation"], license: "MIT", lifecycle: "Normal", trial_due: null, author: "skill-hub", source_kind: "local", source_locator: "C:/Preview/release-notes", current_version: "v2", current_version_label: "v2", agent_deployment_count: 0, agent_deployment_target_ids: [], project_deployment_count: 1, basic_check: "passed", ai_check: "not_checked", high_risk_count: 0 },
    ];
    const skillOperations = { skill_id: "pdf-reader", entries: [{ operation_id: "op-import-1", kind: "import", phase: "committed", error_code: null }], filtered: false, limitation: "skill_dimension_not_recorded" };
    const pending = [{ subject: "pdf-reader", kind: "security_finding", code: "secret-like-string", message_code: "pending.messages.securityFinding", due_date: null, risk: "high", affected_deployments: 1 }];
    const ignoreRules = [{ id: "ignore-1", subject: { type: "exact_pending", value: "security_finding:pdf-reader:secret-like-string" }, reason: "preview rule", created_at: "2026-09-08T08:00:00Z", defer_until: null }];
    const project = { id: "project-aurora", name: "Aurora", device_path: "C:/Preview/Aurora", physical_id: "aurora-physical", logical: { identity_hint: "C:/Preview/Aurora", note: "Preview project" }, tags: [{ name: "demo" }, { name: "Rust" }], agent_ids: ["codex-target"], created_at: "2026-09-08T08:00:00Z", updated_at: "2026-09-08T08:00:00Z" };
    const preferences = { network_enabled: true, llm_provider: "", data_scope: "explicit_selection", language: "en-US", theme: "light", density: "standard", automation_per_skill: false, automation_batch: false, automation_global: false, backup_location: null, backup_retention_days: 30 };
    const operationSummary = { operation_id: "op-preview", phase: "committed", state: "committed", completed: 1, total: 1, error_code: null };

    const ok = (type: string, payload: unknown) => ({ type, payload });
    const invoke = async (command: string, args: any = {}) => {
      if (command === "plugin:event|listen") return 1;
      if (command === "plugin:event|unlisten" || command === "plugin:event|emit") return null;
      if (command === "plugin:dialog|open") return "C:/Preview/auditor";
      if (command === "pick_local_directory") return JSON.stringify({ path: "C:/Preview/auditor", grant_id: "C:/Preview/auditor" });
      if (command === "plugin:app|version") return "0.2.0";
      if (command === "plugin:window|theme") return null;
      if (command === "query_application") {
        const query = args.query;
        switch (query.type) {
          case "get_bootstrap_snapshot": return ok("bootstrap_snapshot", bootstrap);
          case "get_discovery_snapshot": return ok("discovery_snapshot", discovery);
          case "list_skill_repos": return ok("skill_repos", repos);
          case "search_online_sources": return ok("source_search_page", onlinePage);
          case "discover_repo_skills": return ok("repo_discovery_report", repoReport);
          case "discover_agents_lock_skills": return ok("agents_lock_entries", lockEntries);
          case "list_deployments": return ok("deployments", deployments);
          case "list_deployment_targets": return ok("deployment_targets", deploymentTargets);
          case "list_skills": return ok("skill_page", { items: skillItems, total: skillItems.length, page: query.payload.page, page_size: query.payload.page_size, tags: ["documents", "automation"] });
          case "get_deployment_relations": return ok("deployment_relations", deployments);
          case "list_skill_operations": return ok("skill_operations", skillOperations);
          case "diff_versions": return ok("version_diff", { added: ["new section"], changed: ["SKILL.md"], removed: [] });
          case "check_source_updates": return ok("source_update_checks", [{ skill_id: "pdf-reader", state: "update_available" }]);
          case "get_deployment_plan": return ok("deployment_plan", { skill_id: query.payload.request.skill_id, version_id: query.payload.request.version_id, runtime_name: query.payload.request.runtime_name, mode: "symbolic_link", targets: [{ physical_target_id: "codex-physical", logical_target_ids: ["codex-target"], target_path: "C:/Preview/.agents", destination_path: "C:/Preview/.agents/pdf-reader", source_path: "C:/Preview/SkillHub/skills/pdf-reader", runtime_name: query.payload.request.runtime_name, skill_id: query.payload.request.skill_id, version_id: query.payload.request.version_id, mode: "symbolic_link", change: "no_op", warnings: [], conflicts: [] }], warnings: [], conflicts: [] });
          case "list_pending_items": return ok("pending_items", pending);
          case "list_ignore_rules": return ok("ignore_rules", ignoreRules);
          case "get_ui_preference": return ok("ui_preference", { key: query.payload?.key, value_json: JSON.stringify({ kind: "all" }) });
          case "list_custom_agents": return ok("custom_agents", []);
          case "list_projects": return ok("projects", [project]);
          case "get_project_assembly_plan": return ok("assembly_plan", { id: "assembly-1", operation_id: "op-assembly", project_id: project.id, committed: false, items: [
            { requirement: { skill_id: "pdf-reader", name: "PDF Reader", logical_agent_id: "codex-target" }, status: "already_satisfied", version_id: "v1", reasons: [], choice: null, conflict_kind: null, allowed_choices: [] },
            { requirement: { skill_id: "release-notes", name: "Release Notes", logical_agent_id: "codex-target" }, status: "conflict_needs_choice", version_id: null, reasons: ["target conflict"], choice: null, conflict_kind: "deployment_target_conflict", allowed_choices: ["acquire", "skip"] },
          ] });
          case "preview_project_directory": return ok("project_directory_preview", { path: query.payload.path, agent_traces: discovery.logical_targets, skill_candidates: [{ runtime_name: "PDF Reader", absolute_root: "C:/Preview/Aurora/pdf" }] });
          case "read_shared_project_config": return ok("shared_project_config", { project_identity_hint: project.device_path, required_skills: [{ name: "PDF Reader", skill_id: "pdf-reader", logical_agent_id: "codex-target" }] });
          case "get_desktop_preferences": return ok("desktop_preferences", preferences);
          case "get_application_update_policy": return ok("application_update_policy", { enabled: true, check_on_startup: false });
          case "get_skill": return ok("skill", { ...skillItems.find((item) => item.skill_id === query.payload.skill_id) ?? skillItems[0], page_url: "https://github.com/anthropics/skills", installs: 1200, is_duplicate: false });
          case "list_versions": return ok("versions", [{ version_id: "v1", skill_id: query.payload.skill_id, current: true, sequence: 1, created_at_epoch: 1788854400, file_count: 1, added: 0, changed: 0, removed: 0 }, { version_id: "v0", skill_id: query.payload.skill_id, current: false, sequence: 0, created_at_epoch: 1788768000, file_count: 1, added: 1, changed: 0, removed: 0 }]);
          case "get_basic_check_result": return ok("basic_check_result", { skill_id: "pdf-reader", version_id: "v1", state: "passed", run_id: "run-1", ruleset_id: "rules-1", checked_at: "2026-09-08T08:00:00Z", finding_count: 1, actionable_count: 1 });
          case "get_llm_safety_check_result": return ok("llm_safety_check_result", { skill_id: "pdf-reader", version_id: "v1", state: "not_checked", run_id: null, model_id: null, checked_at: null, finding_count: 0, actionable_count: 0 });
          case "list_findings": return ok("findings", query.payload.kind === "basic" ? [{ id: "finding-1", code: "secret-like-string", severity: "error", file: "SKILL.md", line_start: 18, line_end: 18, high_risk: true, disposition: "actionable" }] : []);
          case "list_running_llm_checks": return ok("running_llm_checks", []);
          case "list_combinations": return ok("combinations", [{ id: "combo-1", name: "Docs bundle", members: ["pdf-reader"] }]);
          default: return ok("bootstrap_snapshot", bootstrap);
        }
      }
      if (command === "execute_command") {
        const action = args.command;
        switch (action.type) {
          case "scan_targets": return ok("scan_result", { discovered: [{ fingerprint: "same" }, { fingerprint: "same" }], errors: [{ path: "C:/Preview/missing", reason: "unreadable" }] });
          case "discover_agent_targets": return ok("discovery_snapshot", discovery);
          case "add_skill_repo":
          case "remove_skill_repo": return ok("skill_repos", repos);
          case "download_repo_skill": return ok("downloaded_repo_skill", { local_path: "C:/Preview/downloaded/pdf", runtime_name: "pdf-reader" });
          case "set_desktop_preferences": return ok("desktop_preferences", preferences);
          case "read_shared_project_config": return ok("shared_project_config", { project_identity_hint: project.device_path, required_skills: [{ name: "PDF Reader", skill_id: "pdf-reader", logical_agent_id: "codex-target" }] });
          case "open_external_url":
          case "open_official_release":
          case "set_finding_disposition":
          case "create_ignore_rule":
          case "remove_ignore_rule":
          case "run_health_check": return action.type === "run_health_check" ? ok("health_report", { id: "health-1", findings: [{ code: "repairable", severity: "warning", repair: { action: "remove_duplicate" } }] }) : ok("operation_summary", operationSummary);
          case "prepare_repair": return ok("repair_plan", { id: "repair-1", changes: [{ path: "SKILL.md", action: "remove_duplicate" }] });
          case "run_rolling_backup": return ok("backup_retention_result", { retained: 3, removed: 1 });
          case "verify_backup": return ok("backup_manifest", { format_version: 1, entries: [], contains_sensitive_skill_content: false });
          case "prepare_restore": return ok("restore_plan", { format_version: 1, skills: 1, deployments_requiring_rediscovery: 0, conflicts: [{ skill_id: "pdf-reader", detail: "Existing Skill", kind: "same_skill" }] });
          case "commit_restore": return ok("restore_result", { skills_restored: 1, skills_skipped: 0, deployments_requiring_rediscovery: 0 });
          case "prepare_standard_export": return ok("export_plan", { selection: { skills: ["pdf-reader"] }, versions: "current", skills: [{ skill_id: "pdf-reader", version_id: "v1", content: "# PDF", display_name: "PDF Reader" }], sensitive_items: [{ skill_id: "pdf-reader", reason: "contains credential-like content" }] });
          case "create_standard_export": return ok("export_result", { path: "C:/Preview/skillhub-export.zip", skills_exported: 1 });
          case "list_recovery_candidates": return ok("recovery_candidates", []);
          case "acknowledge_recovery": return ok("operation_summary", operationSummary);
          case "set_ui_preference": return ok("operation_summary", operationSummary);
          case "prepare_deployment": return ok("prepared_deployment", { id: "prepared-deploy-1", operation_id: "op-deploy-1", plan: args.command.payload.plan });
          case "commit_deployment": return ok("deployment_summary", { operation_id: "op-deploy-1", skill_id: args.command.payload.prepared_deployment_id, version_id: "v1", committed: true, targets: [{ logical_target_ids: ["codex-target"], physical_target_id: "codex-physical", status: "succeeded", error_code: null }] });
          case "check_source_update": return ok("upstream_check_result", { skill_id: "pdf-reader", state: "update_available", local_version: "v1", upstream_version: "v2", upstream_label: "v2.0.0" });
          case "apply_source_update": return ok("applied_source_update", { skill_id: "pdf-reader", decision: args.command.payload.decision, new_version: args.command.payload.decision === "take_upstream" ? "v2" : null, deployments_need_reconciliation: false });
          case "relink_source":
          case "set_version_label":
          case "set_current_version": return ok("operation_summary", operationSummary);
          case "create_combination":
          case "update_combination":
          case "delete_combination": return ok("operation_summary", operationSummary);
          case "remove_custom_agent": return ok("operation_summary", operationSummary);
          case "create_custom_agent": return ok("custom_agent", { id: "custom-auditor", display_name: "Auditor", directory: { grant_id: "C:/Preview/auditor" }, profile: { brand: "Acme", official_references: ["https://acme.example/docs"], clients: [{ id: "auditor", kind: "cli" }] } });
          case "prepare_uninstall": return ok("uninstall_impact", { deployments, actions: ["backup", "undeploy_all", "retain_central_library"], preserves_central_library: true });
          case "apply_uninstall_decision": return ok("operation_summary", operationSummary);
          case "update_project": return ok("project", project);
          default: return ok("operation_summary", operationSummary);
        }
      }
      return null;
    };
    Object.defineProperty(window, "isTauri", { configurable: true, value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        transformCallback(callback: (payload: unknown) => void) { const id = ++callbackId; callbacks.set(id, callback); return id; },
        unregisterCallback(id: number) { callbacks.delete(id); },
        invoke,
        convertFileSrc(path: string) { return path; },
      },
    });
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { configurable: true, value: { unregisterListener() {} } });
  });
}

test("overview metrics, chart dimensions, and tag drilldown remain navigable", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: /4 skills/ })).toHaveAttribute("href", "/library");
  await expect(page.getByText("documents")).toBeVisible();
  await page.getByRole("radio", { name: "Projects" }).check();
  await expect(page.getByRole("img", { name: "Deployment count by project" })).toBeVisible();
});

test("discovery home and local workbench expose separate navigation and scan facts", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/discovery");
  await expect(page.getByRole("heading", { name: "Discover", exact: true })).toBeVisible();
  await page.locator("article").filter({ has: page.getByRole("heading", { name: "Local discovery" }) }).getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/discovery\/local$/);
  await expect(page.getByRole("heading", { name: "Local discovery", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rescan" }).click();
  await expect(page.getByText(/Unmanaged 2/)).toBeVisible();
  await expect(page.getByText(/Unreadable 1/)).toBeVisible();
});

test("online, repository, and lock discovery expose deterministic result states", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/discovery/online");
  await page.getByRole("textbox", { name: "Search skills.sh" }).fill("pdf");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("PDF Reader")).toBeVisible();

  await page.goto("/discovery/repo");
  await expect(page.getByText("anthropics/skills@main")).toBeVisible();
  await page.getByRole("button", { name: "Scan repositories" }).click();
  await expect(page.getByText("PDF Reader")).toBeVisible();
  await expect(page.getByText(/myclaude failed to scan/)).toBeVisible();

  await page.goto("/discovery/lock");
  await page.getByRole("button", { name: "Scan lock file" }).click();
  await expect(page.getByText(/PDF Reader/)).toBeVisible();
  await expect(page.getByText(/anthropics\/skills/)).toBeVisible();
});

test("agents and projects expose inspectable records and guarded forms", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/agents");
  await expect(page.getByRole("main").getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add custom Agent" }).click();
  await expect(page.getByRole("heading", { name: "Add custom Agent" })).toBeVisible();
  await page.getByRole("textbox").nth(2).fill("invalid");
  await page.getByRole("textbox").nth(0).fill("Auditor");
  await page.getByRole("textbox").nth(1).fill("Acme");
  await page.getByRole("button", { name: "Pick directory" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toContainText("http");

  await page.goto("/projects");
  await expect(page.getByRole("button", { name: "Aurora" })).toBeVisible();
  await page.getByRole("textbox", { name: "Search projects" }).fill("does-not-exist");
  await expect(page.getByRole("status")).toContainText("No projects");
});

test("pending, recovery, and security routes expose state boundaries", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/pending");
  await expect(page.getByText("pdf-reader", { exact: true })).toBeVisible();
  await expect(page.getByText(/High risk/)).toBeVisible();
  await page.getByLabel("Item type").selectOption("recovery");
  await expect(page.getByRole("status")).toContainText("No pending items match this filter");

  await page.goto("/recovery");
  await expect(page.getByRole("heading", { name: "Recovery" })).toBeVisible();
  await page.getByRole("tab", { name: "Backup & restore" }).click();
  await expect(page.getByText(/full backup\/restore flow/i)).toBeVisible();

  await page.goto("/library/pdf-reader/security");
  await expect(page.getByRole("heading", { name: "Basic security check" })).toBeVisible();
  await expect(page.getByText("SKILL.md:18")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run AI check" })).toBeDisabled();
});

test("data protection exposes export, restore, retention, and uninstall previews", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/settings/data-protection");
  await expect(page.getByText("C:\\Preview\\SkillHub")).toBeVisible();
  await page.getByRole("textbox", { name: "Skill IDs" }).fill("pdf-reader");
  await page.getByRole("combobox", { name: "Export format" }).selectOption("zip");
  await page.getByRole("button", { name: "Review export" }).click();
  await expect(page.getByText(/1 skills are ready to export/)).toBeVisible();
  await page.getByRole("combobox", { name: "Export decision for pdf-reader" }).selectOption("include_and_mark");
  await expect(page.getByRole("button", { name: "Create export" })).toBeEnabled();

  await page.getByRole("button", { name: "Run rolling backup" }).click();
  await expect(page.getByText(/Rolling backup finished: 3 kept/)).toBeVisible();
  await page.getByLabel(/Select deployment dep-1/).check();
  await page.getByRole("button", { name: "Preview impact" }).click();
  await expect(page.getByText(/affected/)).toBeVisible();
});

test("settings exposes ordered sections and application update boundary", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/settings");
  const sections = page.locator(".sh-settings-section__title");
  await expect(sections).toHaveCount(6);
  await expect(sections.nth(0)).toHaveText("General");
  await expect(sections.nth(1)).toHaveText("Data protection");
  await expect(sections.nth(5)).toHaveText("App update");
  await expect(page.getByText("Shared storage is not connected yet")).toBeVisible();
});

test("deployment target selection exposes unavailable and non-atomic batch boundaries", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/deploy?skill=pdf-reader&skill=release-notes");
  await expect(page.getByRole("heading", { name: "Deploy 2 Skills" })).toBeVisible();
  await expect(page.getByLabel("Unavailable target")).toBeDisabled();
  await expect(page.getByText(/not atomic/i)).toBeVisible();
  await page.getByLabel("Codex CLI").check();
  await expect(page.getByRole("button", { name: "Preview deployment" })).toBeEnabled();
  await page.getByRole("button", { name: "Preview deployment" }).click();
  await expect(page.getByRole("heading", { name: "Deployment plan" })).toBeVisible();
});

test("combination manager loads skill names and guards creation", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/library/combinations");
  await expect(page.getByRole("heading", { name: "Combination manager" })).toBeVisible();
  await expect(page.getByText("Docs bundle", { exact: true })).toBeVisible();
  await expect(page.getByText("PDF Reader", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New combination" }).click();
  await page.getByPlaceholder("e.g. Writing stack").fill("Audit bundle");
  await page.getByLabel("PDF Reader").check();
  await expect(page.getByRole("button", { name: "Save combination" })).toBeEnabled();
});

test("project detail shows access, agent associations, and assembly status", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/projects/project-aurora");
  await expect(page.getByRole("heading", { name: "Aurora" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "openai · codex" })).toBeChecked();
  await expect(page.getByText(/Already satisfied/)).toBeVisible();
  await expect(page.getByText(/Conflict needs a choice/)).toBeVisible();
});

test("operations records link to a committed operation detail", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/operations");
  await page.getByRole("link", { name: "import" }).click();
  await expect(page).toHaveURL(/\/operations\/op-import-1$/);
  await expect(page.getByRole("heading", { name: "Operation status" })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "100");
});

test("native skill detail exposes metadata, relations, findings, and versions", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/library/pdf-reader");
  await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Identity and source" })).toBeVisible();
  await expect(page.getByText("MIT", { exact: true })).toBeVisible();
  await expect(page.getByText("Codex CLI", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Version history" }).click();
  await expect(page).toHaveURL(/#versions$/);
  await expect(page.getByRole("heading", { name: "v1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check source updates" }).click();
  await expect(page.getByText(/Update available: local v1/)).toBeVisible();
  await page.getByRole("button", { name: "Keep local" }).click();
  await expect(page.getByText("Kept the local version.")).toBeVisible();
  await page.getByLabel("Select v1 for comparison").check();
  await page.getByLabel("Select v0 for comparison").check();
  await page.getByRole("button", { name: "Compare selected versions" }).click();
  await expect(page.getByRole("region", { name: "Changed file details" })).toContainText("SKILL.md");
  await page.getByRole("button", { name: "Rollback to v0" }).click();
  await expect(page.getByRole("heading", { name: "Rollback impact preview" })).toBeVisible();
  await expect(page.getByText(/Codex CLI will update/)).toBeVisible();
});
