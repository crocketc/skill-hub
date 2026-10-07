import { expect, test, type Page } from "@playwright/test";

/**
 * Browser-only IPC harness. It exercises the production routes and facades
 * with deterministic facts; it never touches a real directory, network, or
 * Tauri side effect.
 */
async function installNativePreview(page: Page) {
  await page.addInitScript(() => {
    let callbackId = 0;
    let conflictResolved = false;
    // 来源更新的会话内状态：检查后才出现可采用候选；采用后回到最新。
    let sourceUpdateState: { state: string; checked_at: string; upstream_label: string; candidate_identity: string } | null = null;
    const callbacks = new Map<number, (payload: unknown) => void>();
    const bootstrap = {
      initialization_state: "initialized",
      library_path: "C:\\Preview\\SkillHub",
      onboarding_skipped: false,
      agent_count: 2,
      discovered_agent_count: 2,
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
        kind: "import_skill",
        object_name: "Fixture pack",
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
      // T6（dabbc70）起 ClientInstance 契约包含 supported_os 与 client_presence
      // （Rust 端必填序列化，workbench 的 buildAgentGroups 直接读取），
      // 预览快照必须与真实 IPC 契约逐字段对齐。
      instances: [
        { profile_id: "openai", client_id: "codex", kind: "cli", supported_os: ["windows", "macos"], client_presence: "Unknown" },
        { profile_id: "anthropic", client_id: "claude", kind: "cli", supported_os: ["windows", "macos"], client_presence: "Unknown" },
      ],
      logical_targets: [
        { id: "codex-target", profile_id: "openai", client_id: "codex", scope: "global", path: "C:/Preview/.agents", marker: "SKILL.md", precedence: "preferred", exists: true, readable: true, writable: true, available: true, physical_id: "codex-physical" },
        { id: "claude-target", profile_id: "anthropic", client_id: "claude", scope: "global", path: "C:/Preview/.claude", marker: "SKILL.md", precedence: "fallback", exists: true, readable: true, writable: true, available: true, physical_id: "claude-physical" },
      ],
      physical_targets: [
        { id: "codex-physical", path: "C:/Preview/.agents", exists: true, readable: true, writable: true, case_behavior: "volume_case_behavior_unknown_preserved_case_fallback", logical_target_ids: ["codex-target"] },
        { id: "claude-physical", path: "C:/Preview/.claude", exists: true, readable: true, writable: true, case_behavior: "volume_case_behavior_unknown_preserved_case_fallback", logical_target_ids: ["claude-target"] },
      ],
    };
    const agentDirectoryProjection = {
      directories: [
        {
          role: "agent_user",
          identity: { kind: "verified_physical", value: "codex-physical" },
          path: "C:/Preview/.agents",
          status: "existing",
          exists: true,
          readable: true,
          writable: true,
          available: true,
          members: [{
            logical_target_id: "codex-target",
            brand: "OpenAI",
            client_id: "codex",
            kind: "cli",
            availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
            capabilities: {
              deployment: { copy: true, symlink: true, junction: true },
              modes: ["managed_copy", "symbolic_link", "directory_junction"],
              preferred_mode: "symbolic_link",
            },
            deployment_status: "deployed",
            managed_deployment_relation_count: 1,
            managed_deployment_count: 1,
          }],
        },
        {
          role: "agent_user",
          identity: { kind: "verified_physical", value: "claude-physical" },
          path: "C:/Preview/.claude",
          status: "existing",
          exists: true,
          readable: true,
          writable: true,
          available: true,
          members: [{
            logical_target_id: "claude-target",
            brand: "Anthropic",
            client_id: "claude",
            kind: "cli",
            availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
            capabilities: {
              deployment: { copy: true, symlink: false, junction: false },
              modes: ["managed_copy"],
              preferred_mode: "managed_copy",
            },
            deployment_status: "not_deployed",
            managed_deployment_relation_count: 0,
            managed_deployment_count: 0,
          }],
        },
      ],
    };
    // D4（审查 M1 修复，2026-09-14）：list/add/remove_skill_repos 的载荷已
    // 换成 SkillRepoView[]（{ repo, scan }，scan 为该仓最近一次扫描状态或
    // null）。mock 必须与 bindings.ts 契约逐字段对齐，否则 /discovery/repo
    // 读取 view.repo 时直接 TypeError。
    const repos = [
      {
        repo: { owner: "anthropics", name: "skills", branch: "main", enabled: true },
        scan: { scanned_at: "2026-09-13T08:00:00Z", ok: true, candidate_count: 3, error: null },
      },
      {
        repo: { owner: "ComposioHQ", name: "awesome-claude-skills", branch: "main", enabled: false },
        scan: null,
      },
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
      // T6（830eb1d）起逐仓告警按 describeRepoWarning 分类转译：后端 reason
      // 是自由错误串（error.to_string()），已知类别隐藏原始串并给出可读文案。
      warnings: [{ owner: "cexll", name: "myclaude", reason: "DOWNLOAD_FAILED status=404 Not Found" }],
    };
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
    const skillOperations = { skill_id: "pdf-reader", entries: [{ operation_id: "op-import-1", kind: "import_skill", phase: "committed", error_code: null }], filtered: false, limitation: "skill_dimension_not_recorded" };
    const pending = [{ subject: "pdf-reader", kind: "security_finding", code: "secret-like-string", message_code: "pending.messages.securityFinding", due_date: null, risk: "high", affected_deployments: 1 }];
    const pendingWorkspace = [
      { id: "work:security_finding:pdf-reader:v1:run-1:finding-1", kind: "security_finding", subject: "pdf-reader", display_name: "PDF Reader", message_code: "pending.reasons.security_finding", recommended: false, can_defer: false, can_ignore: false, can_confirm: false, version_id: "v1", finding_id: "finding-1", check_kind: "basic", path: null, due_date: null, risk: "high", source_roots: [] },
      { id: "work:conflict:preview-conflict:active", kind: "conflict", subject: "import-conflict:same_name_different_content:find-skills", display_name: "PDF Reader / Release Notes", message_code: "pending.reasons.conflict", recommended: false, can_defer: false, can_ignore: false, can_confirm: false, version_id: null, finding_id: null, check_kind: null, path: null, due_date: null, risk: null, source_roots: [] },
    ];
    const ignoreRules = [{ id: "ignore-1", subject: { type: "exact_pending", value: "security_finding:pdf-reader:secret-like-string" }, reason: "preview rule", created_at: "2026-09-08T08:00:00Z", defer_until: null }];
    const project = { id: "project-aurora", name: "Aurora", device_path: "C:/Preview/Aurora", physical_id: "aurora-physical", logical: { identity_hint: "C:/Preview/Aurora", note: "Preview project" }, tags: [{ name: "demo" }, { name: "Rust" }], agent_ids: ["codex-target"], created_at: "2026-09-08T08:00:00Z", updated_at: "2026-09-08T08:00:00Z" };
    const preferences = { network_enabled: true, llm_provider: "", data_scope: "explicit_selection", language: "en-US", theme: "light", density: "standard", automation_per_skill: false, automation_batch: false, automation_global: false, backup_location: null, backup_retention_days: 30 };
    const operationSummary = { operation_id: "op-preview", phase: "committed", state: "committed", completed: 1, total: 1, error_code: null };
    // 组合目录用可变状态承载，重命名后的 list_combinations 反映新名称；
    // 组合命令类型按序记录，供用例断言“真实发出了哪个命令”。
    const combinationsState = [{ id: "combo-1", name: "Docs bundle", members: ["pdf-reader"] }];
    const combinationCommands: string[] = [];
    (window as unknown as { __combinationCommands: string[] }).__combinationCommands = combinationCommands;

    const ok = (type: string, payload: unknown) => ({ type, payload });
    type PreviewQuery = {
      type: string;
      payload: {
        page?: number;
        page_size?: number;
        items?: Array<{ skill_id: string; logical_target_ids: string[]; preference: string }>;
        request?: { logical_target_ids: string[]; skill_id: string; version_id: string; runtime_name: string };
        key?: string;
        path?: string;
        skill_id?: string;
        kind?: string;
      };
    };
    type PreviewCommand = {
      type: string;
      payload: {
        conflict_id?: string;
        decision?: string;
        plan?: unknown;
        preview_id?: string;
        pairs?: Array<{ pair_id: string; confirm_fallback: boolean; exclude: boolean }>;
        prepared_deployment_id?: string;
        skill_id?: string;
        to?: string;
      };
    };
    type PreviewInvokeArgs = { query?: PreviewQuery; command?: PreviewCommand };
    const invoke = async (command: string, args: PreviewInvokeArgs = {}) => {
      if (command === "plugin:event|listen") return 1;
      if (command === "plugin:event|unlisten" || command === "plugin:event|emit") return null;
      if (command === "plugin:dialog|open") return "C:/Preview/auditor";
      if (command === "pick_local_directory") return JSON.stringify({ path: "C:/Preview/auditor", grant_id: "C:/Preview/auditor" });
      if (command === "plugin:app|version") return "0.2.0";
      if (command === "plugin:window|theme") return null;
      if (command === "query_application") {
        const query = args.query!;
        switch (query.type) {
          case "get_bootstrap_snapshot": return ok("bootstrap_snapshot", bootstrap);
          case "get_discovery_snapshot": return ok("discovery_snapshot", discovery);
          case "get_agent_directory_projection": return ok("agent_directory_projection", agentDirectoryProjection);
          case "list_skill_repos": return ok("skill_repos", repos);
          case "search_online_sources": return ok("source_search_page", onlinePage);
          case "discover_repo_skills": return ok("repo_discovery_report", repoReport);
          case "list_deployments": return ok("deployments", deployments);
          case "list_deployment_targets": return ok("deployment_targets", deploymentTargets);
          case "list_skills": return ok("skill_page", { items: skillItems, total: skillItems.length, page: query.payload.page, page_size: query.payload.page_size, tags: ["documents", "automation"] });
          case "get_deployment_relations": return ok("deployment_relations", deployments);
          case "list_skill_operations": return ok("skill_operations", skillOperations);
          case "diff_versions": return ok("version_diff", { added: ["new section"], changed: ["SKILL.md"], removed: [] });
          case "check_source_updates": return ok("source_update_checks", [{ skill_id: "pdf-reader", state: "update_available" }]);
          // K6：来源更新面板的持久化状态投影（从未检查过的诚实缺省）。
          // 真实流接线轮后检查是显式动作：check_source_update 执行后才把
          // 状态投影翻到 update_available，供「预览采用影响」入口出现。
          case "get_source_update_status": return ok("source_update_status", {
            skill_id: query.payload.skill_id ?? "pdf-reader",
            state: sourceUpdateState?.state ?? null,
            checked_at: sourceUpdateState?.checked_at ?? null,
            upstream_label: sourceUpdateState?.upstream_label ?? null,
            candidate_identity: sourceUpdateState?.candidate_identity ?? null,
            ignored_candidates: [],
            candidate_ignored: false,
          });
          // 恢复候选走的是 **查询**（`queryApplication { type: "list_recovery_candidates" }`），
          // 不是命令；写在下面 execute_command 分支里等于没接线，恢复页只能拿到
          // default 的 bootstrap_snapshot，于是整页落进错误态。
          case "list_recovery_candidates": return ok("recovery_candidates", []);
          // 任务 9 冻结指标带（任务 10 接线）：概览冲突计数与三个关系缩略
          // 入口消费任务 1/2/3 只读查询；真实产品路由（"/"）同样需要确定性
          // 关系事实，才能在无 Tauri 后端的浏览器里呈现冻结契约。
          case "list_skill_relationship_candidates": return ok("skill_relationship_candidates", [
            { skill_id: "pdf-reader", display_name: "PDF Reader", runtime_name: "pdf-reader", tags: ["documents"], matched_alias: null, relationship_count: 2, relationship_revision: "preview-rel-1", last_verified_at: null },
            { skill_id: "release-notes", display_name: "Release Notes", runtime_name: "release-notes", tags: ["automation"], matched_alias: null, relationship_count: 1, relationship_revision: "preview-rel-1", last_verified_at: null },
          ]);
          case "get_conflict_workspace": return ok("conflict_workspace", { cases: conflictResolved ? [] : [{ case: { classification: "uncertain", conflict_id: "import-conflict:same_name_different_content:find-skills", evidence: { fingerprints_match: null, names_match: true, sufficient_identity_evidence: false }, member_skill_ids: ["pdf-reader", "release-notes"], members: [{ skill_id: "pdf-reader", version_id: "v1", provenance_id: null, directory_node_id: null, path: "C:/Preview/SkillHub/skills/find-skills", fingerprint: "fnv1a:0abc" }, { skill_id: "release-notes", version_id: "v2", provenance_id: null, directory_node_id: null, path: "C:/Preview/.claude/skills/find-skills", fingerprint: "fnv1a:0def" }] }, latest_analysis: null, analysis_stale: false, recommended_decision: null }], handled_count: 0, handled: [], relationship_revision: "preview-rel-1", last_verified_at: null });
          // 真实流接线轮（W3-5/ed0cdf39）：使用去向卡以治理清单行为单一事实
          // 来源，清单必须携带真实行——两条部署关系（待接管独立副本 + 已接管
          // 受管链接）与一条只读导入原件（已完成保留）。counts 保持既有口径
          // 不动：概览「2 to handle」= status_needs_validation + status_blocked，
          // 关系页签治理计数 = counts.all，均被其他用例断言。
          case "list_relation_governance": return ok("relation_governance_ledger", {
            rows: [
              {
                relation: { kind: "deployment", fact: {
                  relation_id: "rel:pdf-reader:codex-copy", skill_id: "pdf-reader",
                  agent_client_id: "openai.codex-cli", path: "C:/Preview/.agents/skills/pdf-reader",
                  path_key: "c:/preview/.agents/skills/pdf-reader", directory_node_id: "codex-physical",
                  relationship: "observed_copy", file_representation: "copy", ownership: "observed_unmanaged",
                  link_target_path: null, link_target_path_key: null, link_target_directory_id: null,
                  content_fingerprint: "sha256:preview-pdf-reader", origin: "import",
                  match_state: "content_verified", health_reasons: [], active: true,
                  observed_at: "2026-09-08T08:00:00Z", released_at: null } },
                skill_display_name: "PDF Reader", status: "normal",
                readiness: "eligible_to_centralize", primary_action: "centralize_management",
                blockers: [], source_read_only: false,
                impact: { other_consumer_agent_ids: [], other_skill_paths: [], backup_required: true, rollback_available: true },
                governance: { governance_status: "pending", management_status: "not_taken_over", decision: "undecided", management_confirmed_at: null, health_reasons: [],
                  action_conditions: [{ action: "centralize_management", available: true, reasons: [] }] },
                target_identity: null,
                evidence_relation_ids: ["rel:pdf-reader:codex-copy"],
              },
              {
                relation: { kind: "deployment", fact: {
                  relation_id: "rel:release-notes:codex-link", skill_id: "release-notes",
                  agent_client_id: "openai.codex-cli", path: "C:/Preview/.agents/skills/release-notes",
                  path_key: "c:/preview/.agents/skills/release-notes", directory_node_id: "codex-physical",
                  relationship: "managed_link", file_representation: "symbolic_link", ownership: "skillhub_managed",
                  link_target_path: "C:/Preview/SkillHub/skills/release-notes",
                  link_target_path_key: "c:/preview/skillhub/skills/release-notes",
                  link_target_directory_id: "library", content_fingerprint: "sha256:preview-release-notes",
                  origin: "deployment", match_state: "content_verified",
                  health_reasons: ["verification_required"], active: true,
                  observed_at: "2026-09-08T08:00:00Z", released_at: null } },
                skill_display_name: "Release Notes", status: "needs_validation",
                readiness: "needs_validation", primary_action: "revalidate",
                blockers: [], source_read_only: false,
                impact: { other_consumer_agent_ids: [], other_skill_paths: [], backup_required: false, rollback_available: true },
                governance: { governance_status: "pending", management_status: "taken_over", decision: "undecided", management_confirmed_at: "2026-09-08T08:00:00Z",
                  health_reasons: ["verification_required"],
                  action_conditions: [{ action: "revalidate", available: true, reasons: [] }] },
                target_identity: { skill_id: "release-notes", target_kind: "agent", directory_node_id: "codex-physical", entry_path_key: "c:/preview/.agents/skills/release-notes" },
                evidence_relation_ids: ["rel:release-notes:codex-link"],
              },
              {
                relation: { kind: "source_copy", fact: {
                  relation_id: "rel:pdf-reader:source-copy", skill_id: "pdf-reader",
                  latest_provenance_id: "prov-pdf-reader", source_class: "agent_local",
                  source_path: "C:/Users/demo/.agents/skills/pdf-reader",
                  source_path_key: "c:/users/demo/.agents/skills/pdf-reader",
                  physical_source_id: "codex-physical", source_container_id: null,
                  directory_node_id: "codex-physical", agent_client_id: "openai.codex-cli",
                  expected_fingerprint: "sha256:preview-pdf-reader", current_fingerprint: "sha256:preview-pdf-reader",
                  decision: "retained", health: "normal", health_reasons: [], active: true,
                  last_verified_at: "2026-09-08T08:00:00Z", archived_at: null, archive_reason: null } },
                skill_display_name: "PDF Reader", status: "retained",
                readiness: "already_centralized", primary_action: "none",
                blockers: [], source_read_only: true,
                impact: { other_consumer_agent_ids: [], other_skill_paths: [], backup_required: false, rollback_available: false },
                governance: { governance_status: "completed", management_status: "not_taken_over", decision: "retained_independent_copy", management_confirmed_at: null, health_reasons: [], action_conditions: [] },
                target_identity: null,
                evidence_relation_ids: ["rel:pdf-reader:source-copy"],
              },
            ],
            counts: { all: 3, eligible_to_centralize: 1, needs_validation: 1, blocked: 1, status_normal: 1, status_retained: 0, status_needs_validation: 1, status_needs_attention: 0, status_blocked: 1, source_copies: 1, deployments: 2 },
            bucket: "all", total: 3, relationship_revision: "preview-rel-1", last_verified_at: null,
          });
          case "get_deployment_batch_preview": {
            // 任务 13B/14 契约：预览按 Skill × 物理目标 pair 返回结构化处置。
            // find-skills 场景的占用组合（→ Claude Code）仍以 target_occupied
            // 演练阻断组；其余 pair 按所选方式执行。
            const previewTargets = {
              "codex-target": { label: "Codex CLI", path: "C:/Preview/.agents", physical: "codex-physical" },
              "claude-target": { label: "Claude Code", path: "C:/Preview/.claude", physical: "claude-physical" },
            };
            const nameOf = (skillId: string) => skillItems.find((item) => item.skill_id === skillId)?.display_name ?? skillId;
            const versionOf = (skillId: string) => skillItems.find((item) => item.skill_id === skillId)?.current_version ?? "v1";
            const pairs = query.payload.items.flatMap((item: { skill_id: string; logical_target_ids: string[] }) =>
              item.logical_target_ids.map((targetId: string) => {
                const target = previewTargets[targetId];
                const occupied = targetId === "claude-target";
                return {
                  pair_id: `${item.skill_id}:${target.physical}`,
                  skill_id: item.skill_id,
                  skill_display_name: nameOf(item.skill_id),
                  version_id: versionOf(item.skill_id),
                  runtime_name: item.skill_id,
                  logical_target_ids: [targetId],
                  target_label: target.label,
                  target_path: target.path,
                  destination_path: `${target.path}/${item.skill_id}`,
                  preference: item.preference,
                  disposition: occupied ? "blocked" : "selected_mode",
                  mode: occupied ? null : "managed_copy",
                  fallback_mode: null,
                  block_reason: occupied ? "target_occupied" : null,
                  warnings: [],
                  confirmation_preserved: false,
                  confirmation_fingerprint: `preview-fp-${item.skill_id}-${targetId}`,
                  technical_error: null,
                };
              }));
            const previewId = "preview-native-1";
            const now = Date.now();
            return ok("deployment_batch_preview", {
              preview_id: previewId,
              expires_at: new Date(now + 600000).toISOString(),
              pairs,
              preserved_confirmation_ids: pairs.filter((pair) => pair.confirmation_preserved).map((pair) => pair.pair_id),
            });
          }
          case "get_deployment_plan": {
            // DEV-18：占用组合（真实场景 find-skills → Claude Code，目标目录
            // 已有同名副本）在规划期即被 D-11 占用识别拒绝。mock 以结构化
            // AppError 复现同款失败，验证页面渲染可读文案与「纳入技能库
            // 管理」引导，而不是 [object Object]。
            if (query.payload.request.logical_target_ids.includes("claude-target")) {
              throw { code: "deployment.target_exists", severity: "error", params: { path: "C:/Preview/.claude/pdf-reader" }, actions: ["choose_another_name", "inspect_target"] };
            }
            return ok("deployment_plan", { skill_id: query.payload.request.skill_id, version_id: query.payload.request.version_id, runtime_name: query.payload.request.runtime_name, mode: "symbolic_link", targets: [{ physical_target_id: "codex-physical", logical_target_ids: ["codex-target"], target_path: "C:/Preview/.agents", destination_path: "C:/Preview/.agents/pdf-reader", source_path: "C:/Preview/SkillHub/skills/pdf-reader", runtime_name: query.payload.request.runtime_name, skill_id: query.payload.request.skill_id, version_id: query.payload.request.version_id, mode: "symbolic_link", change: "no_op", warnings: [], conflicts: [] }], warnings: [], conflicts: [] });
          }
          case "list_pending_items": return ok("pending_items", pending);
          case "get_pending_workspace": return ok("pending_workspace", { items: pendingWorkspace.filter((item) => !conflictResolved || item.kind !== "conflict"), unavailable_sources: [] });
          case "list_pending_confirmations": return ok("pending_confirmations", []);
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
          case "list_combinations": return ok("combinations", combinationsState);
          default: throw new Error(`Unhandled preview query: ${query.type}`);
        }
      }
      if (command === "execute_command") {
        const action = args.command!;
        if (action.type === "create_combination" || action.type === "update_combination" || action.type === "delete_combination" || action.type === "rename_combination") {
          combinationCommands.push(action.type);
        }
        switch (action.type) {
          case "resolve_conflict_case": {
            conflictResolved = true;
            return ok("conflict_resolved", { conflict_id: action.payload.conflict_id, decision: action.payload.decision, decided_at: "2026-09-26T09:00:00Z", conclusion: "distinct_skill", governance: null, relationship_revision: "preview-rel-2" });
          }
          case "scan_targets": return ok("scan_result", {
            generation: { generation: 2, observed_at: 1789114968 },
            roots: ["C:/Preview/SkillHub/skills"],
            discovered: [
              {
                root: "C:/Preview/SkillHub/skills",
                relative_path: "pdf-reader",
                path: "C:/Preview/SkillHub/skills/pdf-reader",
                marker: "SKILL.md",
                marker_size: 1,
                marker_modified_at: 1,
                size: 1,
                latest_modified_at: 1,
                fingerprint: "same",
                metadata_fingerprint: "pdf-reader-metadata",
              },
              {
                root: "C:/Preview/SkillHub/skills",
                relative_path: "release-notes",
                path: "C:/Preview/SkillHub/skills/release-notes",
                marker: "SKILL.md",
                marker_size: 1,
                marker_modified_at: 1,
                size: 1,
                latest_modified_at: 1,
                fingerprint: "same",
                metadata_fingerprint: "release-notes-metadata",
              },
            ],
            visited_paths: [
              "C:/Preview/SkillHub/skills/pdf-reader",
              "C:/Preview/SkillHub/skills/release-notes",
            ],
            reparsed_count: 2,
            unchanged_count: 0,
            errors: [{ path: "C:/Preview/missing", code: "directory.unreadable" }],
          });
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
          // K3 两段式导出：prepare 只产出预览绑定三件套（export_preview），
          // create 只带 preview_id + 决定并返回 export_result。
          case "prepare_standard_export": return ok("export_preview", { selection: { skills: ["pdf-reader"] }, versions: "current", skills: [{ skill_id: "pdf-reader", version_id: "v1", display_name: "PDF Reader" }], sensitive_items: [{ skill_id: "pdf-reader", version_id: "v1", path: "SKILL.md", reason: "contains credential-like content" }], preview_id: "export-preview-1", expires_at: new Date(Date.now() + 600000).toISOString(), confirmation_fingerprint: "export-fp-1" });
          case "create_standard_export": return ok("export_result", { path: "C:/Preview/skillhub-export.zip", skills_exported: 1 });
          case "resolve_recovery": return ok("operation_summary", operationSummary);
          case "set_ui_preference": return ok("operation_summary", operationSummary);
          case "prepare_deployment": return ok("prepared_deployment", { id: "prepared-deploy-1", operation_id: "op-deploy-1", plan: args.command.payload.plan });
          case "commit_deployment_preview": {
            // 13B：提交只携带 preview_id + pair 意见（confirm_fallback/exclude），
            // 后端 revalidate 语义在 mock 上投影为：exclude→excluded，其余→deployed。
            return ok("deployment_preview_commit_result", {
              preview_id: action.payload.preview_id,
              replayed: false,
              pairs: action.payload.pairs.map((pair: { pair_id: string; confirm_fallback: boolean; exclude: boolean }) => ({
                pair_id: pair.pair_id,
                outcome: pair.exclude ? "excluded" : "deployed",
                operation_id: pair.exclude ? null : "op-deploy-1",
                error: null,
              })),
            });
          }
          case "commit_deployment": return ok("deployment_summary", { operation_id: "op-deploy-1", skill_id: args.command.payload.prepared_deployment_id, version_id: "v1", committed: true, targets: [{ logical_target_ids: ["codex-target"], physical_target_id: "codex-physical", status: "succeeded", error_code: null, residue: false }] });
          case "check_source_update": {
            sourceUpdateState = { state: "update_available", checked_at: "2026-09-08T09:00:00Z", upstream_label: "v2.0.0", candidate_identity: "sha256:source-candidate-1" };
            return ok("upstream_check_result", { skill_id: "pdf-reader", state: "update_available", local_version: "v1", upstream_version: "v2", upstream_label: "v2.0.0" });
          }
          // K6 预览绑定流：采纳入口 prepare 出三件套预览，决定经 commit 消耗。
          case "prepare_source_update": return ok("source_update_preview", { skill_id: action.payload.skill_id ?? "pdf-reader", preview_id: "preview-source-1", expires_at: new Date(Date.now() + 600000).toISOString(), confirmation_fingerprint: "source-fp-1", current_version_id: "v1", candidate_identity: "sha256:source-candidate-1", upstream_label: "v2.0.0", files: [{ path: "SKILL.md", change: "modified" }] });
          case "commit_source_update": {
            sourceUpdateState = { state: "up_to_date", checked_at: "2026-09-08T09:01:00Z", upstream_label: "v2.0.0", candidate_identity: "sha256:source-candidate-1" };
            return ok("applied_source_update", { skill_id: "pdf-reader", decision: action.payload.decision, new_version: action.payload.decision === "take_upstream" ? "v2" : null, deployments_need_reconciliation: false });
          }
          case "relink_source":
          case "set_version_label":
          case "set_current_version": return ok("operation_summary", operationSummary);
          case "create_combination":
          case "update_combination":
          case "delete_combination": return ok("operation_summary", operationSummary);
          case "rename_combination": {
            combinationsState[0].name = action.payload.to;
            return ok("combination", { name: action.payload.to, members: combinationsState[0].members });
          }
          case "remove_custom_agent": return ok("operation_summary", operationSummary);
          case "create_custom_agent": return ok("custom_agent", { id: "custom-auditor", display_name: "Auditor", directory: { grant_id: "C:/Preview/auditor" }, profile: { brand: "Acme", official_references: ["https://acme.example/docs"], clients: [{ id: "auditor", kind: "cli" }] } });
          case "prepare_uninstall": return ok("uninstall_impact", { deployments, actions: ["backup", "undeploy_all", "retain_central_library"], preserves_central_library: true });
          case "apply_uninstall_decision": return ok("operation_summary", operationSummary);
          case "update_project": return ok("project", project);
          default: throw new Error(`Unhandled preview command: ${action.type}`);
        }
      }
      return null;
    };
    Object.defineProperty(window, "isTauri", { configurable: true, value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        // D4（审查跟进，2026-09-14）：标题栏自绘窗口控制（WindowControls →
        // resolveWindowChrome → getCurrentWindow）在 Tauri 运行时读取
        // metadata.currentWindow.label；mock 环境声明了 __TAURI_INTERNALS__
        // 就必须同时补齐该契约，否则壳层在首屏直接崩溃。
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
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
  // 任务 9 冻结五指标（任务 10 迁移）：hero=技能总数，钻取 /library。
  await expect(page.getByRole("link", { name: "4 Total skills" })).toHaveAttribute("href", "/library");
  // 冲突计数来自任务 2 工作台投影；三个缩略入口按冻结契约给出深链。
  await expect(
    page.getByRole("link", { name: "1 Unconfirmed relationship conflicts" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open relationship graph (2 skills with displayable relations)" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open conflict workspace (1 unconfirmed conflicts)" }),
  ).toBeVisible();
  // 任务 10/12 后治理缩略入口的口径是「待处理关系数」
  // （stub: status_needs_validation 1 + status_blocked 1 = 2）。
  await expect(
    page.getByRole("link", { name: "Open needs-governance relations (2 to handle)" }),
  ).toBeVisible();
  await expect(page.getByText("documents")).toBeVisible();
  await page.getByRole("radio", { name: "Projects" }).check();
  await expect(page.getByRole("img", { name: "Configuration relation count by project" })).toBeVisible();
});

test("native preview fixtures return typed results and fail loudly for unknown IPC actions", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/");

  const contract = await page.evaluate(async () => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const projection = await internals.invoke("query_application", {
      query: { type: "get_agent_directory_projection" },
    }) as { type: string; payload: { directories: unknown[] } };
    const scan = await internals.invoke("execute_command", {
      command: { type: "scan_targets", payload: { scope_ids: [] } },
    }) as {
      type: string;
      payload: {
        generation: { generation: number; observed_at: number };
        roots: string[];
        discovered: Array<{
          root: string;
          relative_path: string;
          marker: string;
          metadata_fingerprint: string;
        }>;
        visited_paths: string[];
        reparsed_count: number;
        unchanged_count: number;
        errors: Array<{ path: string; code: string }>;
      };
    };
    let unknownQueryError = "";
    try {
      await internals.invoke("query_application", {
        query: { type: "fixture_contract_probe" },
      });
    } catch (error) {
      unknownQueryError = error instanceof Error ? error.message : String(error);
    }
    let unknownCommandError = "";
    try {
      await internals.invoke("execute_command", {
        command: { type: "fixture_contract_probe", payload: {} },
      });
    } catch (error) {
      unknownCommandError = error instanceof Error ? error.message : String(error);
    }
    return { projection, scan, unknownQueryError, unknownCommandError };
  });

  expect(contract.projection).toMatchObject({
    type: "agent_directory_projection",
    payload: { directories: expect.any(Array) },
  });
  expect(contract.scan).toMatchObject({
    type: "scan_result",
    payload: {
      generation: { generation: expect.any(Number), observed_at: expect.any(Number) },
      roots: expect.any(Array),
      discovered: expect.arrayContaining([expect.objectContaining({
        root: expect.any(String),
        relative_path: expect.any(String),
        marker: "SKILL.md",
        metadata_fingerprint: expect.any(String),
      })]),
      visited_paths: expect.any(Array),
      reparsed_count: expect.any(Number),
      unchanged_count: expect.any(Number),
      errors: [expect.objectContaining({ path: expect.any(String), code: expect.any(String) })],
    },
  });
  expect(contract.scan.payload.discovered).toHaveLength(2);
  expect(contract.unknownQueryError).toContain("Unhandled preview query: fixture_contract_probe");
  expect(contract.unknownCommandError).toContain("Unhandled preview command: fixture_contract_probe");
});

test("discovery home and local workbench expose separate navigation and scan facts", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/discovery");
  // 2026-09-17 顶栏标题降级为非 heading（基线回归 §5.4）：模块名经顶栏标题
  // 断言；页面自身 h1 为发现首页标语。
  await expect(page.locator(".sh-app-shell__title")).toHaveText("Discover");
  await expect(
    page.getByRole("heading", { name: "Find Skills from trusted sources", exact: true }),
  ).toBeVisible();
  await page.locator("article").filter({ has: page.getByRole("heading", { name: "Local discovery" }) }).getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/discovery\/local$/);
  await expect(page.getByRole("heading", { name: "Local discovery", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rescan" }).click();
  await expect(page.getByText(/Unmanaged 2/)).toBeVisible();
  await expect(page.getByText(/Unreadable 1/)).toBeVisible();
});

// M-18（审查跟进）：jsdom 不做真实布局，单测里改写 innerWidth/innerHeight
// 对结构断言没有效果；"两档视口下首屏无需滚动即可操作"必须在真实浏览器
// 几何下验证——重扫、审查并导入、导入 Skill 三个入口的包围盒完整落在
// 800x600 与 1280x900 视口内（spec-only，只增强不放松）。
for (const [width, height] of [[800, 600], [1280, 900]] as const) {
  test(`keeps local discovery scan and import actions above the fold at ${width}x${height}`, async ({ page }) => {
    await installNativePreview(page);
    await page.setViewportSize({ width, height });
    await page.goto("/discovery/local");
    await expect(page.getByRole("heading", { name: "Local discovery", exact: true })).toBeVisible();
    // 先产生一次扫描结果，让"审查并导入"进入可用状态，再量几何。
    await page.getByRole("button", { name: "Rescan" }).click();
    await expect(page.getByText(/Unmanaged 2/)).toBeVisible();

    for (const name of ["Rescan", "Review and import", "Import Skill"]) {
      const control = page.getByRole("button", { name });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box, `${name} renders in the layout`).not.toBeNull();
      expect(box!.x, `${name} left edge stays inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(box!.y, `${name} top edge stays inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(
        box!.x + box!.width,
        `${name} right edge stays inside the viewport`,
      ).toBeLessThanOrEqual(width);
      expect(
        box!.y + box!.height,
        `${name} is reachable at ${width}x${height} without scrolling`,
      ).toBeLessThanOrEqual(height);
    }
  });
}

test("online and repository discovery expose deterministic result states", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/discovery/online");
  await page.getByRole("textbox", { name: "Search skills.sh" }).fill("pdf");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("PDF Reader")).toBeVisible();

  await page.goto("/discovery/repo");
  // 仓库卡片标题是 owner/name；branch 独立成行展示（分支不再拼进标题）。
  await expect(page.getByText("anthropics/skills", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Scan repositories" }).click();
  await expect(page.getByText("PDF Reader")).toBeVisible();
  // T6（830eb1d）：逐仓失败分类转译——404 命中 notFound 文案、原始错误串
  // 不再直出，且该仓库有独立重试入口。
  await expect(page.getByText("cexll/myclaude")).toBeVisible();
  await expect(page.getByText(/The repository or branch does not exist/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry scanning cexll/myclaude" })).toBeVisible();
  await expect(page.getByText(/DOWNLOAD_FAILED/)).toHaveCount(0);

  // D4（审查 M1 修复，2026-09-14）：仓库管理独立页消费 SkillRepoView 的
  // scan 载荷——成功仓回显“上次扫描 + 候选数”，从未扫描的仓如实展示。
  await page.goto("/discovery/repositories");
  await expect(page.getByRole("heading", { name: "Repository management" })).toBeVisible();
  await expect(page.getByText("anthropics/skills", { exact: true })).toBeVisible();
  // 两张仓库卡都有「Last scan」字段；逐一限定到各自卡片内断言。
  const anthropicCard = page.getByLabel("anthropics/skills", { exact: true });
  await expect(anthropicCard.getByText("Last scan")).toBeVisible();
  // DEV-91（2026-09-25 验收反馈）：候选数改为「识别到 N 个技能」chip。
  await expect(anthropicCard.getByText("3 skills identified")).toBeVisible();
  const composioCard = page.getByLabel("ComposioHQ/awesome-claude-skills", { exact: true });
  await expect(composioCard.getByText("Never scanned")).toBeVisible();

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

test("unified pending follows a conflict to resolution and updates overview totals", async ({ page }, testInfo) => {
  await installNativePreview(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "2 pending items" })).toBeVisible();
  await page.getByRole("link", { name: "1 skill conflicts", exact: true }).click();
  const specificItem = page.getByLabel("Specific item");
  await expect(specificItem).toHaveValue("conflict");
  await expect(page.getByRole("button", { name: "Relationships 1" })).toHaveAttribute("aria-pressed", "true");
  await specificItem.selectOption("all");
  await page.screenshot({ path: testInfo.outputPath("unified-pending.png"), fullPage: true });
  await specificItem.selectOption("conflict");
  await expect(page.getByRole("button", { name: "Ignore", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show item details: Skill conflicts" }).click();
  const conflictItem = page
    .getByRole("region", { name: "Relationships" })
    .getByRole("listitem")
    .filter({ hasText: "PDF Reader / Release Notes" });
  await expect(conflictItem.getByRole("group", { name: "Suggested actions for PDF Reader / Release Notes" })).toBeVisible();
  const go = conflictItem
    .getByRole("group", { name: "Suggested actions for PDF Reader / Release Notes" })
    .getByRole("link", { name: "Open task" });
  await expect(go).toHaveAttribute("href", /relationships\/decisions\?conflictId=/);
  await go.click();
  await expect(page).toHaveURL(/relationships\/decisions\?conflictId=/);
  await page.getByRole("button", { name: "Keep as separate Skills", exact: true }).click();
  await expect(page.getByText("No conflicts are waiting for your review.")).toBeVisible();
  await page.getByRole("link", { name: "Pending", exact: true }).click();
  await page.getByLabel("Specific item").selectOption("conflict");
  await expect(page.getByText("No pending items match this filter")).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "1 pending items" })).toBeVisible();
});

test("pending, recovery, and security routes expose state boundaries", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/pending");
  await expect(page.locator(".sh-pending__list").getByText("PDF Reader", { exact: true })).toBeVisible();
  await expect(page.getByText("pdf-reader", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/High risk/)).toBeVisible();
  await page.getByLabel("Specific item").selectOption("recovery");
  await expect(page.getByRole("status")).toContainText("No pending items match this filter");

  await page.goto("/recovery");
  // 2026-09-17 顶栏标题降级为非 heading（基线回归 §5.4）：恢复页经页面自身
  // 标题（recovery.heading）断言，不再依赖顶栏 h1 的子串匹配。
  await expect(
    page.getByRole("heading", { name: "Recover the unfinished operation" }),
  ).toBeVisible();
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
  // 敏感项呈现统一用显示名（K3-B）：决定下拉按显示名命名，不裸露 skill_id。
  await page.getByRole("combobox", { name: "Export decision for PDF Reader" }).selectOption("include_and_mark");
  await expect(page.getByRole("button", { name: "Create export" })).toBeEnabled();
  await page.getByRole("button", { name: "Create export" }).click();
  await expect(page.getByText(/Export created at/)).toBeVisible();
  // K3-B 预览冻结：预览后修改任一绑定选择即作废旧预览——可见的重新预览
  // 提示出现，创建入口撤下，绝不拿旧预览直接落盘。
  await page.getByRole("combobox", { name: "Export format" }).selectOption("folder");
  await expect(page.getByText(/no longer valid/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create export" })).toHaveCount(0);

  await page.getByRole("button", { name: "Run rolling backup" }).click();
  await expect(page.getByText(/Rolling backup finished: 3 kept/)).toBeVisible();
  await page.getByLabel(/Select deployment relation dep-1/).check();
  await page.getByRole("button", { name: "Preview impact" }).click();
  await expect(page.getByText(/affected/)).toBeVisible();
});

test("settings exposes ordered sections and application update boundary", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/settings");
  const tabs = page
    .getByRole("tablist", { name: "Settings sections" })
    .getByRole("tab");
  await expect(tabs).toHaveCount(7);
  await expect(tabs).toHaveText([
    "General",
    "Interface & view",
    "Data protection",
    "Network & AI",
    "Automation",
    "Library maintenance",
    "App update",
  ]);
  await tabs.nth(6).click();
  await expect(page.getByText("Shared storage is not connected yet")).toBeVisible();
});

test("deployment target selection exposes unavailable and non-atomic batch boundaries", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/deploy?skill=pdf-reader&skill=release-notes");
  await expect(page.getByRole("heading", { name: "Add 2 Skills" })).toBeVisible();
  // DEV-11：不可用目标不再出现在默认选择列表（用户裁定：不显示）。
  await expect(page.getByLabel("Unavailable target")).toHaveCount(0);
  // T4-D：非原子批量风险随流程进入 footer 操作区，紧邻提交动作。
  const footer = page.locator("footer");
  await expect(footer).toContainText(/not atomic/i);
  await page.getByLabel("Codex CLI").check();
  await expect(page.getByRole("button", { name: "Preview" })).toBeEnabled();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("heading", { name: "Planned additions" })).toBeVisible();
  // T4-D：提交动作移入同一 footer 操作区，仍与非原子风险相邻。
  await expect(footer.getByRole("button", { name: "Confirm and add" })).toBeEnabled();
  await page.getByRole("button", { name: "Confirm and add" }).click();
  await expect(page.getByTestId("batch-summary")).toBeVisible();
  await expect(page.getByText("Adding finished")).toBeVisible();
});

test("preview occupancy conflict renders readable guidance instead of [object Object]", async ({ page }) => {
  // DEV-18 回归护栏（任务 14 pair UX 后）：占用组合在「无法执行」分组给出
  // 用户可读的阻断原因，裸错误对象/内部标识不进入首屏；无确认门槛时
  // 提交保持禁用（不可执行项不能混进批次）。
  await installNativePreview(page);
  await page.goto("/deploy?skill=pdf-reader");
  await page.getByLabel("Claude Code").check();
  await page.getByRole("button", { name: "Preview" }).click();

  const blockedGroup = page.getByTestId("disposition-group").filter({ hasText: "Cannot execute" });
  await expect(blockedGroup).toContainText("PDF Reader");
  await expect(blockedGroup).toContainText(/target directory already contains/i);
  await expect(blockedGroup).not.toContainText("[object Object]");
  // DEV-99：内部 pair id 全面退出界面——技术详情折叠区也不再展示原始标识。
  await expect(blockedGroup.locator("details")).toHaveCount(0);
  await expect(blockedGroup).not.toContainText("pdf-reader:claude-physical");
  await expect(page.getByRole("button", { name: "Confirm and add" })).toBeDisabled();
});

test("conflict workbench keeps members readable, actions reachable and preview scrollable at 800x600 (DEV-2)", async ({ page }) => {
  // J-REL-3 内容判据的浏览器自动化复测（准-B 同构素材：同名不同内容组）：
  // ① 成员列表可读；② 处理动作区可达；③ 根元素无横向溢出。
  await installNativePreview(page);
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/relationships/decisions");

  // DEV-67：模块标题由顶栏承载；断言顶栏 + 页签导航可达。
  await expect(page.locator(".sh-app-shell__title")).toHaveText("Skill relations");
  await expect(page.getByRole("navigation", { name: "Relationship sections" })).toBeVisible();

  // ① 成员列表：两个成员路径以统一展示形态可读，且都在视口内。
  const memberCodes = page.locator("code", { hasText: "find-skills" });
  await expect(memberCodes).toHaveCount(2);
  for (let index = 0; index < await memberCodes.count(); index += 1) {
    const box = (await memberCodes.nth(index).boundingBox())!;
    expect(box.x, "member path stays inside the viewport").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(800);
  }

  // ② 动作区可达：处理决定控件完整落在视口内。
  const decision = page.locator("section.sh-conflict-actions").first();
  await decision.scrollIntoViewIfNeeded();
  const decisionBox = (await decision.boundingBox())!;
  expect(decisionBox.y, "decision controls scroll fully into view at 800x600").toBeGreaterThanOrEqual(0);
  expect(decisionBox.y + decisionBox.height, "decision controls stay reachable at 800x600").toBeLessThanOrEqual(608);

  // ③ 根元素无横向溢出。
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("relationship module exposes in-page navigation with counts between the three scopes", async ({ page }) => {
  // DEV-23 回归护栏：三个子页此前只能从概览卡片或直达 URL 进入，页内无任何
  // 入口；现在页签必须可达且计数与概览同源（candidates=2 / conflicts=1 / governance=3）。
  await installNativePreview(page);
  await page.goto("/relationships");

  // DEV-67：模块标题由 AppShell 顶栏承载，页内只有页签导航。
  await expect(page.locator(".sh-app-shell__title")).toHaveText("Skill relations");
  await expect(page.getByRole("navigation", { name: "Relationship sections" })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Relationship sections" });
  await expect(nav.getByRole("link", { name: "Skill graph" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByTestId("relationships-nav-count-graph")).toHaveText("2");
  await expect(nav.getByTestId("relationships-nav-count-decisions")).toHaveText("1");
  await expect(nav.getByTestId("relationships-nav-count-governance")).toHaveText("3");

  await nav.getByRole("link", { name: "Conflict decisions" }).click();
  await expect(page).toHaveURL(/\/relationships\/decisions$/);
  // 顶栏标题按模块固定（Skill relations），子页切换只体现为页签高亮与 URL。
  await expect(nav.getByRole("link", { name: "Conflict decisions" })).toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: "Relationship governance" }).click();
  await expect(page).toHaveURL(/\/relationships\/governance$/);
  await expect(nav.getByRole("link", { name: "Relationship governance" })).toHaveAttribute("aria-current", "page");

  // 概览卡片深链入口保持不变。
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Open conflict workspace (1 unconfirmed conflicts)" }),
  ).toHaveAttribute("href", "/relationships/decisions");
});

test("combination manager maintains members, renames, and guards duplicates", async ({ page }) => {
  const combinationCommands = () =>
    page.evaluate(() => (window as unknown as { __combinationCommands: string[] }).__combinationCommands);
  await installNativePreview(page);
  await page.goto("/library/combinations");
  await expect(page.getByRole("heading", { name: "Combination manager" })).toBeVisible();
  await expect(page.getByText("Docs bundle", { exact: true })).toBeVisible();
  await expect(page.getByText("PDF Reader", { exact: true })).toBeVisible();

  // 创建：重名在提交前被本地拦截，不发出 create_combination 命令。
  await page.getByRole("button", { name: "New combination" }).click();
  await page.getByRole("checkbox", { name: "PDF Reader" }).check();
  await page.getByPlaceholder("e.g. Writing stack").fill("Docs bundle");
  await page.getByRole("button", { name: "Save combination" }).click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  await expect.poll(combinationCommands).toEqual([]);

  // 编辑成员：成员经真实查询候选列表勾选，保存发出 update_combination。
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Edit members Docs bundle" }).click();
  await expect(page.getByRole("checkbox", { name: "PDF Reader" })).toBeChecked();
  await page.getByRole("button", { name: "Save members" }).click();
  await expect.poll(combinationCommands).toContain("update_combination");

  // 重命名：发出 rename_combination，刷新后的列表以新名称呈现。
  await page.getByRole("button", { name: "Rename Docs bundle" }).click();
  await page.getByLabel("New name").fill("Docs bundle v2");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Docs bundle v2", { exact: true })).toBeVisible();
  await expect.poll(combinationCommands).toContain("rename_combination");
});

test("project detail shows access, agent associations, and assembly status", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/projects/project-aurora");
  await expect(page.getByRole("heading", { name: "Aurora" })).toBeVisible();
  // Agent 呈现约定：勾选项统一用品牌与展示类型命名，不暴露 client_id。
  await expect(page.getByRole("checkbox", { name: "OpenAI · Terminal" })).toBeChecked();
  await expect(page.getByText("OpenAI")).toBeVisible();
  await expect(page.getByText(/Already satisfied/)).toBeVisible();
  await expect(page.getByText(/Conflict needs a choice/)).toBeVisible();
});

test("operations records link to a committed operation detail", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/operations");
  await page.getByRole("link", { name: "Import skill: Fixture pack" }).click();
  await expect(page).toHaveURL(/\/operations\/op-import-1$/);
  await expect(page.getByRole("heading", { name: "Import skill: Fixture pack" })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "100");
});

test("native skill detail surfaces review sections, source adoption, and versions", async ({ page }) => {
  await installNativePreview(page);
  await page.goto("/library/pdf-reader");
  await expect(page.getByRole("heading", { name: "PDF Reader" })).toBeVisible();
  // §9 裁决（2026-10-06）：评审原型即生产默认呈现。概览区呈现许可证等
  // 主体事实；使用去向区以真实关系数据呈现治理状态（native 夹具：独立副本待接管）。
  await expect(page.getByText("MIT", { exact: true })).toBeVisible();
  // 真实流接线轮（ed0cdf39/治理卡收口）：去向卡详情改写为行动导向措辞，
  // 待接管的独立副本直接给出治理入口指引，徽标为「待集中管理」。
  await expect(page.getByText("原位置仍是独立副本；可在关系治理中纳入集中管理。")).toBeVisible();
  // 来源更新区（真实流，K6）：显式关联网络来源 → 显式只读检查 → 采用影响
  // 预览 → 确认采用。关联只登记来源（不替换内容、不自动检查）；检查通过
  // 后才出现采用入口；采用前先看文件级影响预览。
  await page.getByRole("button", { name: "关联更新来源" }).click();
  const chooser = page.getByRole("dialog");
  await expect(chooser).toContainText("关联网络更新来源");
  await expect(chooser).toContainText("来源类型由你显式选择；SkillHub 不会从地址文本猜测协议，也不会替换当前内容。");
  await chooser.getByLabel("来源地址").fill("https://example.com/pdf-reader.git");
  await chooser.getByRole("button", { name: "确认关联" }).click();
  await expect(page.getByText("已登记更新来源；可随时执行只读检查。")).toBeVisible();
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByText("来源检查完成：发现可采用的更新候选。")).toBeVisible();
  await expect(page.getByText("发现可采用的更新候选（v2.0.0）。")).toBeVisible();
  await page.getByRole("button", { name: "预览采用影响" }).click();
  const adoptDialog = page.getByRole("dialog");
  await expect(adoptDialog).toContainText("采用更新影响预览");
  await expect(adoptDialog).toContainText("确认后将按以下文件级变化创建新版本；当前内容保留为历史版本。");
  await expect(adoptDialog).toContainText("来源版本：v2.0.0");
  await expect(adoptDialog).toContainText("SKILL.md（修改）");
  await adoptDialog.getByRole("button", { name: "确认采用更新" }).click();
  await expect(page.getByText("已采用来源更新并创建新版本。")).toBeVisible();
  // 版本历史区：对比两个版本后按评审流回滚，影响预览先行、确认创建恢复版本。
  await page.getByRole("link", { name: "版本历史" }).click();
  await expect(page).toHaveURL(/#review-versions$/);
  await expect(page.locator("#review-versions .sh-version-timeline")).toBeVisible();
  await page.getByLabel("Select v1 for comparison").check();
  await page.getByLabel("Select v0 for comparison").check();
  await page.getByRole("button", { name: "Compare selected versions" }).click();
  await expect(page.getByRole("region", { name: "Changed file details" })).toContainText("SKILL.md");
  await page.getByRole("button", { name: "恢复到 v0" }).click();
  const rollbackPreview = page.locator("#review-versions").getByRole("region", { name: "恢复影响预览" });
  await expect(rollbackPreview).toBeVisible();
  // 评审态影响预览如实分列恢复结果。确认提交链路由 edit-recover.spec 在
  // 预览路由覆盖；native 桩未实现 rollback 提交，这里断言到预览与确认入口为止。
  await expect(rollbackPreview).toContainText("恢复会创建新的当前版本，原当前版本保留在历史中。");
  await expect(rollbackPreview).toContainText("Codex CLI will update");
  await expect(rollbackPreview.getByRole("button", { name: "确认创建恢复版本" })).toBeVisible();
});
