import { expect, it } from "vitest";
import type { DeploymentRecord } from "../../api/bindings";
import {
  countManagedDeployments,
  deploymentTargetIdSpace,
  indexTargetsByAnyId,
} from "./targetProjection";

function record(targetId: string, overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    id: `dep-${targetId}`,
    skill_id: "skill-pdf",
    version_id: "v1",
    target_id: targetId,
    state: "deployed",
    mode: "managed_copy",
    managed: true,
    runtime_name: "pdf",
    expected_hash: "hash",
    observed_hash: null,
    ...overrides,
  };
}

const logical = { id: "openai.codex-cli.user", physicalId: "physical-1" };

it("accepts a deployment written with the physical target id (DEV-22-A)", () => {
  const accepted = deploymentTargetIdSpace([logical]);
  expect(accepted.has("physical-1")).toBe(true);
  expect(countManagedDeployments([record("physical-1")], accepted)).toEqual({
    relations: 1,
    skills: 1,
  });
});

it("keeps counting a deployment written with the logical target id (DEV-22-A)", () => {
  const accepted = deploymentTargetIdSpace([logical]);
  expect(accepted.has("openai.codex-cli.user")).toBe(true);
  expect(countManagedDeployments([record("openai.codex-cli.user")], accepted)).toEqual({
    relations: 1,
    skills: 1,
  });
});

it("projects both id spaces onto one deployment so every view counts it once (DEV-22-A)", () => {
  const accepted = deploymentTargetIdSpace([logical]);
  // 同一条部署在两个 id 空间下都必须被计入，且只计一次。
  expect(countManagedDeployments([record("physical-1"), record("physical-1")], accepted).relations)
    .toBe(2);
  expect(countManagedDeployments([record("openai.codex-cli.user")], accepted).skills).toBe(1);
  // 别的目标的部署不混入。
  expect(countManagedDeployments([record("physical-9")], accepted).relations).toBe(0);
});

it("ignores removed and unmanaged records in both id spaces (DEV-22-A)", () => {
  const accepted = deploymentTargetIdSpace([logical]);
  expect(countManagedDeployments([
    record("physical-1", { state: "removed" }),
    record("openai.codex-cli.user", { managed: false }),
  ], accepted)).toEqual({ relations: 0, skills: 0 });
});

it("resolves a deployment target row by logical id and by physical id (DEV-22-A)", () => {
  const rows = [
    { id: "openai.codex-cli.user", label: "Codex CLI", physical_id: "physical-1" },
    { id: "anthropic.claude-code.user", label: "Claude Code", physical_id: "physical-2" },
  ];
  const index = indexTargetsByAnyId(rows);

  expect(index.get("openai.codex-cli.user")?.label).toBe("Codex CLI");
  expect(index.get("physical-1")?.label).toBe("Codex CLI");
  expect(index.get("physical-2")?.label).toBe("Claude Code");
  expect(index.get("unknown")).toBeUndefined();
});
