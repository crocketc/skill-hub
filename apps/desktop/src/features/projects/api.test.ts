import { expect, it } from "vitest";
import {
  groupAssemblyItems,
  projectFixture,
  resolveProjectAccessState,
  sortSkillCandidatesByTraceAffinity,
  unavailableProjectFacade,
  type ProjectAgentTrace,
  type ProjectAssemblyPlanItemView,
  type ProjectPhysicalTargetView,
  type ProjectSkillCandidatePreview,
} from "./api";

it("keeps production project queries unavailable", async () => {
  await expect(unavailableProjectFacade.list()).rejects.toThrow("unavailable");
});

it("keeps the newer project detail queries unavailable too", async () => {
  await expect(unavailableProjectFacade.getAssemblyPlan("demo")).rejects.toThrow("unavailable");
  await expect(unavailableProjectFacade.listPhysicalTargets()).rejects.toThrow("unavailable");
});

it("provides multiple project tags and itemized assembly states", () => {
  const project = projectFixture();
  expect(project.tags).toEqual(expect.arrayContaining(["客户项目", "Rust"]));
  expect(project.assembly.map((item) => item.status)).toEqual(
    expect.arrayContaining(["satisfied", "skipped", "conflict", "failed"]),
  );
});

it("exposes the device path and physical id needed for access facts", () => {
  const project = projectFixture();
  expect(project.devicePath).toMatch(/.+/);
  expect(project.physicalId).toMatch(/.+/);
});

it("resolves the access state only from the matching physical target", () => {
  const targets: ProjectPhysicalTargetView[] = [
    { exists: true, id: "fs-ok", path: "D:/Work", readable: true, writable: true },
    { exists: true, id: "fs-readonly", path: "E:/Media", readable: true, writable: false },
    { exists: false, id: "fs-gone", path: "Z:/Gone", readable: false, writable: false },
    { exists: true, id: "fs-unreadable", path: "Q:/Locked", readable: false, writable: true },
  ];
  expect(resolveProjectAccessState("fs-ok", targets)).toBe("accessible");
  expect(resolveProjectAccessState("fs-readonly", targets)).toBe("read_only");
  expect(resolveProjectAccessState("fs-gone", targets)).toBe("inaccessible");
  expect(resolveProjectAccessState("fs-unreadable", targets)).toBe("inaccessible");
  expect(resolveProjectAccessState("fs-missing", targets)).toBe("untracked");
});

it("groups assembly plan items by status in a fixed order and drops empty groups", () => {
  const items: ProjectAssemblyPlanItemView[] = [
    { name: "Skipped Skill", reasons: [], skillId: "skipped-skill", status: "skipped" },
    { name: "Ready Skill", reasons: ["缺少版本"], skillId: "ready-skill", status: "ready_to_acquire" },
    { name: "Another Ready Skill", reasons: [], skillId: "ready-skill-2", status: "ready_to_acquire" },
    { name: "Conflict Skill", reasons: ["同名冲突"], skillId: "conflict-skill", status: "conflict_needs_choice" },
    { name: "Satisfied Skill", reasons: [], skillId: "satisfied-skill", status: "already_satisfied" },
    { name: "Failed Skill", reasons: [], skillId: "failed-skill", status: "failed" },
    { name: "Succeeded Skill", reasons: [], skillId: "succeeded-skill", status: "succeeded" },
  ];
  const groups = groupAssemblyItems(items);

  expect(groups.map((group) => group.status)).toEqual([
    "already_satisfied",
    "succeeded",
    "ready_to_acquire",
    "conflict_needs_choice",
    "skipped",
    "failed",
  ]);
  expect(groups.map((group) => group.items.length)).toEqual([1, 1, 2, 1, 1, 1]);
  expect(groups.find((group) => group.status === "ready_to_acquire")?.items.map((item) => item.name)).toEqual([
    "Ready Skill",
    "Another Ready Skill",
  ]);
});

it("groups nothing when the assembly plan has no items", () => {
  expect(groupAssemblyItems([])).toEqual([]);
});

const trace: ProjectAgentTrace = {
  available: true,
  label: "anthropic · anthropic.claude-code",
  marker: "SKILL.md",
  path: "C:/Work/Aurora/.claude/skills",
  targetId: "trace-1",
};

it("ranks candidates inside a traced directory before same-root and unrelated ones", () => {
  const candidates: ProjectSkillCandidatePreview[] = [
    { name: "same-drive", path: "C:/Work/Aurora/docs/notes-skill" },
    { name: "inside-trace", path: "C:/Work/Aurora/.claude/skills/research" },
    { name: "elsewhere", path: "D:/Other/repo-skill" },
    { name: "inside-trace-2", path: "C:/Work/Aurora/.claude/skills/writing" },
  ];

  expect(sortSkillCandidatesByTraceAffinity(candidates, [trace]).map((candidate) => candidate.name)).toEqual([
    "inside-trace",
    "inside-trace-2",
    "same-drive",
    "elsewhere",
  ]);
});

it("does not treat a near-miss directory prefix as a trace hit", () => {
  const candidates: ProjectSkillCandidatePreview[] = [
    { name: "prefix-trap", path: "C:/Work/Aurora/.claude/skills-extra" },
    { name: "inside-trace", path: "C:/Work/Aurora/.claude/skills/research" },
  ];

  expect(sortSkillCandidatesByTraceAffinity(candidates, [trace]).map((candidate) => candidate.name)).toEqual([
    "inside-trace",
    "prefix-trap",
  ]);
});

it("matches trace prefixes across path separator and case differences", () => {
  const windowsTrace: ProjectAgentTrace = { ...trace, path: "C:\\Work\\Aurora\\.claude\\skills" };
  const candidates: ProjectSkillCandidatePreview[] = [
    { name: "plain", path: "C:/Work/Aurora/docs/notes-skill" },
    { name: "windows-style", path: "c:/work/aurora/.Claude/Skills/research" },
  ];

  expect(sortSkillCandidatesByTraceAffinity(candidates, [windowsTrace]).map((candidate) => candidate.name)).toEqual([
    "windows-style",
    "plain",
  ]);
});

it("keeps the original order for candidates with equal affinity", () => {
  const candidates: ProjectSkillCandidatePreview[] = [
    { name: "first", path: "C:/Work/Aurora/docs/first" },
    { name: "second", path: "C:/Work/Aurora/docs/second" },
  ];

  expect(sortSkillCandidatesByTraceAffinity(candidates, [trace]).map((candidate) => candidate.name)).toEqual([
    "first",
    "second",
  ]);
});
