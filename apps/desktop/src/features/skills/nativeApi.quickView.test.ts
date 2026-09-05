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
      license: "MIT",
      lifecycle: "Normal",
      trial_due: null,
      current_version: "v3",
    },
  };
}

it("enriches the quick view with real check states, versions and deployment relations", async () => {
  vi.mocked(queryApplication).mockImplementation(async (query: never) => {
    const request = query as { type: string; payload?: { skill_id?: string; version_id?: string } };
    if (request.type === "get_skill") return skillPayload();
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
      };
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
      };
    }
    if (request.type === "get_deployment_relations") {
      return {
        type: "deployment_relations",
        payload: [
          { id: "d1", skill_id: "skill-pdf", version_id: "v3", target_id: "t1", state: "active", mode: "managed_copy", managed: true, runtime_name: "pdf-reader", expected_hash: "h", observed_hash: "h" },
        ],
      };
    }
    throw new Error(`unexpected query ${request.type}`);
  });

  const view = await nativeSkillLibraryFacade.getSkillQuickView("skill-pdf");
  expect(view.currentVersion).toBe("v3");
  expect(view.basicCheck).toBe("passed");
  expect(view.aiCheck).toBe("failed");
  expect(view.agentDeploymentCount).toBe(1);
  expect(view.agentDeployments?.[0]).toMatchObject({ id: "d1", name: "pdf-reader" });
  // 检查结果必须按当前版本查询
  expect(queryApplication).toHaveBeenCalledWith({
    type: "get_basic_check_result",
    payload: { skill_id: "skill-pdf", version_id: "v3" },
  });
});

it("keeps the quick view honest when the skill has no current version", async () => {
  const payload = skillPayload();
  (payload.payload as { current_version: string | null }).current_version = null;
  vi.mocked(queryApplication).mockImplementation(async (query: never) => {
    const request = query as { type: string };
    if (request.type === "get_skill") return payload;
    throw new Error(`unexpected query ${request.type}`);
  });

  const view = await nativeSkillLibraryFacade.getSkillQuickView("skill-pdf");
  expect(view.currentVersion).toBe("unknown");
  expect(view.basicCheck).toBe("not_run");
  expect(view.aiCheck).toBe("not_run");
  expect(view.agentDeploymentCount).toBe(0);
});
