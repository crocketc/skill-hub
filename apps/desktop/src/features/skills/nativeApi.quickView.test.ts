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
    },
  };
}

it("enriches the quick view with real check states, versions and deployment relations", async () => {
  vi.mocked(queryApplication).mockImplementation(async (query: unknown) => {
    const request = query as { type: string; payload?: { skill_id?: string; version_id?: string } };
    if (request.type === "get_skill") return skillPayload() as never;
    if (request.type === "get_basic_check_result") {
      return {
        type: "basic_check_result",
        payload: {
          skill_id: "skill-pdf",
          version_id: request.payload?.version_id,
          state: "passed",
          run_id: "run-1",
          ruleset_id: null,
          checked_at: null,
          finding_count: 0,
          actionable_count: 0,
        },
      } as never;
    }
    if (request.type === "get_llm_safety_check_result") {
      return {
        type: "llm_safety_check_result",
        payload: {
          skill_id: "skill-pdf",
          version_id: request.payload?.version_id,
          state: "failed",
          run_id: "run-2",
          model_id: "m1",
          checked_at: null,
          finding_count: 2,
          actionable_count: 1,
        },
      } as never;
    }
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
  // QA-010：当前版本展示后端可读标签，而不是内容哈希。
  expect(view.currentVersion).toBe("v3");
  expect(view.currentVersion).not.toContain("sha256:");
  expect(view.basicCheck).toBe("passed");
  expect(view.aiCheck).toBe("failed");
  expect(view.agentDeploymentCount).toBe(1);
  expect(view.agentDeployments?.[0]).toMatchObject({ id: "d1", name: "pdf-reader" });
  // 检查结果必须按原始版本身份（内容哈希）查询，而不是展示标签
  expect(queryApplication).toHaveBeenCalledWith({
    type: "get_basic_check_result",
    payload: {
      skill_id: "skill-pdf",
      version_id: "sha256:3f9a2c7d8e1b4a6f90c2d5e8a1b4c7f0d3e6a9b2c5f8e1a4b7d0c3f6a9b2e5c8",
    },
  });
});

it("keeps the quick view honest when the skill has no current version", async () => {
  const payload = skillPayload();
  (payload.payload as { current_version: string | null }).current_version = null;
  (payload.payload as { current_version_label: string | null }).current_version_label = null;
  vi.mocked(queryApplication).mockImplementation(async (query: unknown) => {
    const request = query as { type: string };
    if (request.type === "get_skill") return payload as never;
    throw new Error(`unexpected query ${request.type}`);
  });

  const view = await nativeSkillLibraryFacade.getSkillQuickView("skill-pdf");
  expect(view.currentVersion).toBe("unknown");
  expect(view.basicCheck).toBe("not_run");
  expect(view.aiCheck).toBe("not_run");
  expect(view.agentDeploymentCount).toBe(0);
});
