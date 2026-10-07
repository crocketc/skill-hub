import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { nativeSkillLibraryFacade } from "./nativeApi";

vi.mock("../../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/bindings")>();
  return { ...original, executeCommand: vi.fn(), queryApplication: vi.fn() };
});

beforeEach(() => {
  vi.mocked(queryApplication).mockReset();
  vi.mocked(executeCommand).mockReset();
});

function skillPayload() {
  return {
    type: "skill",
    payload: {
      skill_id: "skill-pdf",
      display_name: "PDF Reader",
      runtime_name: "pdf-reader",
      original_description: "Reads PDFs",
      translated_description: null,
      user_note: null,
      tags: ["pdf"],

      author: null,
      license: "MIT",
      lifecycle: "Normal",
      trial_due: null,
      // QA-010：current_version 是内容哈希（技术身份），current_version_label
      // 是后端推导的可读标签；抽屉展示标签，检查查询仍用原始版本身份。
      current_version: "sha256:3f9a2c7d8e1b4a6f90c2d5e8a1b4c7f0d3e6a9b2c5f8e1a4b7d0c3f6a9b2e5c8",
      current_version_label: "v3",
      // 与列表投影同源的来源、检查与待处理事实（get_skill 与 list_skills
      // 共用 status_columns 读模型）。
      source_kind: "local",
      source_locator: "/sources/notes",
      basic_check: "passed",
      ai_check: "failed",
      pending_count: 2,
      high_risk_count: 1,
      upstream_state: "update_available",
    },
  };
}

function deploymentTargetsPayload() {
  return {
    type: "deployment_targets",
    payload: [
      {
        id: "t1",
        label: "Codex CLI",
        path: "/agents/codex",
        available: true,
        physical_id: "phys-t1",
        modes: [],
        agent_client_id: "codex-cli",
        agent_profile_id: "openai",
        shared_directory: false,
      },
      {
        id: "t2",
        label: "Alpha Project",
        path: "/ws/alpha",
        available: true,
        physical_id: "phys-t2",
        modes: [],
        agent_client_id: null,
        agent_profile_id: null,
        shared_directory: false,
      },
    ],
  };
}

it("enriches the quick view with same-source facts, relations and project targets", async () => {
  vi.mocked(queryApplication).mockImplementation(async (query: unknown) => {
    const request = query as { type: string };
    if (request.type === "get_skill") return skillPayload() as never;
    if (request.type === "list_deployment_targets") return deploymentTargetsPayload() as never;
    if (request.type === "get_deployment_relations") {
      return {
        type: "deployment_relations",
        payload: [
          { id: "d1", skill_id: "skill-pdf", version_id: "v3", target_id: "t1", state: "active", mode: "managed_copy", managed: true, runtime_name: "pdf-reader", expected_hash: "h", observed_hash: "h" },
          { id: "d2", skill_id: "skill-pdf", version_id: "v3", target_id: "t2", state: "active", mode: "managed_copy", managed: true, runtime_name: "pdf-reader", expected_hash: "h", observed_hash: "h" },
        ],
      } as never;
    }
    throw new Error(`unexpected query ${request.type}`);
  });

  const view = await nativeSkillLibraryFacade.getSkillQuickView("skill-pdf");
  // QA-010：当前版本展示后端可读标签，而不是内容哈希。
  expect(view.currentVersion).toBe("v3");
  expect(view.currentVersion).not.toContain("sha256:");
  // 抽屉读模型与列表同源：检查状态、来源、待处理计数、上游提示。
  expect(view.basicCheck).toBe("passed");
  expect(view.aiCheck).toBe("failed");
  expect(view.pendingCount).toBe(2);
  expect(view.highRiskCount).toBe(1);
  expect(view.source).toBe("/sources/notes");
  expect(view.upgradeAvailable).toBe(true);
  // Agent 与项目使用去向都来自同一份关系事实；计数按类别分开，
  // 项目关系不得再被丢弃，也不得计入 Agent 数量。
  expect(view.agentDeploymentCount).toBe(1);
  expect(view.agentDeployments?.[0]).toMatchObject({ id: "d1", name: "Codex CLI", agentId: "codex-cli", brand: "openai" });
  expect(view.projectDeploymentCount).toBe(1);
  expect(view.projectDeployments?.[0]).toMatchObject({ id: "t2", name: "Alpha Project", path: "/ws/alpha" });
  // 检查状态已由 get_skill 同源携带，不再额外发起两次检查查询。
  expect(queryApplication).not.toHaveBeenCalledWith(expect.objectContaining({ type: "get_basic_check_result" }));
  expect(queryApplication).not.toHaveBeenCalledWith(expect.objectContaining({ type: "get_llm_safety_check_result" }));
});

it("keeps the quick view honest when the skill has no current version", async () => {
  const payload = skillPayload();
  (payload.payload as Record<string, unknown>).current_version = null;
  (payload.payload as Record<string, unknown>).current_version_label = null;
  (payload.payload as Record<string, unknown>).basic_check = "not_checked";
  (payload.payload as Record<string, unknown>).ai_check = "not_checked";
  (payload.payload as Record<string, unknown>).pending_count = 0;
  (payload.payload as Record<string, unknown>).high_risk_count = 0;
  (payload.payload as Record<string, unknown>).upstream_state = null;
  vi.mocked(queryApplication).mockImplementation(async (query: unknown) => {
    const request = query as { type: string };
    if (request.type === "get_skill") return payload as never;
    throw new Error(`unexpected query ${request.type}`);
  });

  const view = await nativeSkillLibraryFacade.getSkillQuickView("skill-pdf");
  // #14：缺版本是事实缺失，门面不得编造英文 "unknown"；由界面用统一文案呈现。
  expect(view.currentVersion).toBeUndefined();
  expect(view.basicCheck).toBe("not_run");
  expect(view.aiCheck).toBe("not_run");
  expect(view.pendingCount).toBe(0);
  expect(view.highRiskCount).toBe(0);
  expect(view.upgradeAvailable).toBe(false);
  expect(view.agentDeploymentCount).toBe(0);
});

it("keeps unknown mixed targets out of Agent and project counts", async () => {
  vi.mocked(queryApplication).mockImplementation(async (query: unknown) => {
    const request = query as { type: string };
    if (request.type === "get_skill") return skillPayload() as never;
    if (request.type === "list_deployment_targets") throw new Error("bridge unavailable");
    if (request.type === "get_deployment_relations") {
      return {
        type: "deployment_relations",
        payload: [
          { id: "d1", skill_id: "skill-pdf", version_id: "v3", target_id: "t1", state: "active", mode: "managed_copy", managed: true, runtime_name: "pdf-reader", expected_hash: "h", observed_hash: "h" },
        ],
      } as never;
    }
    throw new Error(`unexpected query ${request.type}`);
  });

  const view = await nativeSkillLibraryFacade.getSkillQuickView("skill-pdf");
  expect(view.agentDeploymentCount).toBe(0);
  expect(view.agentDeployments).toEqual([]);
  expect(view.unresolvedDeploymentCount).toBe(1);
  // 目标读取失败时不伪造项目事实：项目列诚实为空，计数为 0。
  expect(view.projectDeployments).toEqual([]);
  expect(view.projectDeploymentCount).toBe(0);
});

it("maps the native review date into the drawer quick view", async () => {
  const payload = skillPayload();
  (payload.payload as { trial_due: string | null }).trial_due = "2026-11-03";
  vi.mocked(queryApplication).mockImplementation(async (query: unknown) => {
    const request = query as { type: string };
    if (request.type === "get_skill") return payload as never;
    throw new Error(`unexpected query ${request.type}`);
  });

  const view = await nativeSkillLibraryFacade.getSkillQuickView("skill-pdf");

  expect(view.lifecycle).toBe("trial");
  expect(view.trialDue).toBe("2026-11-03");
});

// W3-6（K9）：主体位置携带后端真实物化根路径；缺失或 null 时如实省略，
// 不派生自显示文本。
it("maps the materialized root path into the drawer quick view", async () => {
  const payload = skillPayload();
  (payload.payload as Record<string, unknown>).root_path = "C:/SkillHub/skills/pdf-reader";
  vi.mocked(queryApplication).mockImplementation(async (query: unknown) => {
    const request = query as { type: string };
    if (request.type === "get_skill") return payload as never;
    throw new Error(`unexpected query ${request.type}`);
  });

  const view = await nativeSkillLibraryFacade.getSkillQuickView("skill-pdf");
  expect(view.rootPath).toBe("C:/SkillHub/skills/pdf-reader");

  const unmaterialized = skillPayload();
  (unmaterialized.payload as Record<string, unknown>).root_path = null;
  vi.mocked(queryApplication).mockImplementation(async (query: unknown) => {
    const request = query as { type: string };
    if (request.type === "get_skill") return unmaterialized as never;
    throw new Error(`unexpected query ${request.type}`);
  });
  const withoutRoot = await nativeSkillLibraryFacade.getSkillQuickView("skill-pdf");
  expect(withoutRoot.rootPath).toBeUndefined();
});
