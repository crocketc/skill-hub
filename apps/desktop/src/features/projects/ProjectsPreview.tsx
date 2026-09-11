import { useMemo, useState } from "react";
import {
  type ProjectAgentCandidate,
  type ProjectDirectoryPreview,
  type ProjectFacade,
  type ProjectPhysicalTargetView,
  type ProjectRegistration,
  type ProjectView,
} from "./api";
import { ProjectListPage } from "./ProjectListPage";

const previewCandidates: ProjectAgentCandidate[] = [
  { id: "codex-target", label: "OpenAI · Codex CLI", available: true },
  { id: "claude-code", label: "anthropic · anthropic.claude-code", available: true },
  { id: "missing-target", label: "Unavailable target", available: false },
];

const previewProjects: ProjectView[] = [
  {
    agentIds: ["codex-target"],
    assembly: [],
    description: "Long-path Windows workspace used for layout checks.",
    devicePath: "D:/Work/very-long-project-paths/aurora-web/workspace/root",
    id: "project-aurora-web",
    name: "Aurora Web",
    physicalId: "aurora-web-physical",
    sharedConfig: {
      identityHint: "D:/Work/very-long-project-paths/aurora-web/workspace/root",
      requirements: ["pdf-reader", "release-notes"],
      targetIds: ["codex-target"],
    },
    tags: ["rust", "web"],
  },
  {
    agentIds: [],
    assembly: [],
    description: "macOS workspace with a deep documentation pipeline.",
    devicePath: "/Users/preview/Workspaces/documentation-pipeline/monorepo/apps/docs",
    id: "project-docs",
    name: "Docs Pipeline",
    physicalId: "docs-physical",
    sharedConfig: {
      identityHint: "/Users/preview/Workspaces/documentation-pipeline/monorepo/apps/docs",
      requirements: [],
      targetIds: [],
    },
    tags: ["docs", "automation"],
  },
  {
    agentIds: [],
    assembly: [],
    description: "",
    devicePath: "C:/Dev/mobile-relay",
    id: "project-relay",
    name: "Mobile Relay",
    physicalId: "relay-physical",
    sharedConfig: {
      identityHint: "C:/Dev/mobile-relay",
      requirements: [],
      targetIds: [],
    },
    tags: [],
  },
];

const previewDirectoryPreview: ProjectDirectoryPreview = {
  path: "C:/Preview/Aurora",
  agentTraces: [
    {
      targetId: "anthropic:claude-code:project:C:/Preview/Aurora/.claude/skills",
      label: "anthropic · anthropic.claude-code",
      marker: "SKILL.md",
      path: "C:/Preview/Aurora/.claude/skills",
      available: true,
    },
  ],
  skillCandidates: [
    { name: "research", path: "C:/Preview/Aurora/.claude/skills/research" },
    { name: "helpers", path: "C:/Preview/Aurora/scripts/helpers" },
  ],
};

const previewPhysicalTargets: ProjectPhysicalTargetView[] = [
  { id: "aurora-web-physical", path: "D:/Work/aurora-web", exists: true, readable: true, writable: true },
];

function createPreviewProjectFacade(initial: ProjectView[]): ProjectFacade {
  let projects = [...initial];
  return {
    list: async () => projects,
    get: async (id) => projects.find((project) => project.id === id) ?? projects[0]!,
    register: async (input: ProjectRegistration) => {
      const registered: ProjectView = {
        agentIds: input.agentIds,
        assembly: [],
        description: "",
        devicePath: input.path,
        id: input.id,
        name: input.name,
        physicalId: `${input.id}-physical`,
        sharedConfig: { identityHint: input.path, requirements: [], targetIds: input.agentIds },
        tags: input.tags,
      };
      projects = [...projects, registered];
      return registered;
    },
    updateAgentIds: async (projectId, agentIds) => {
      const current = projects.find((project) => project.id === projectId) ?? projects[0]!;
      const updated = { ...current, agentIds };
      projects = projects.map((project) => (project.id === current.id ? updated : project));
      return updated;
    },
    setTags: async (projectId, tags) => {
      const current = projects.find((project) => project.id === projectId) ?? projects[0]!;
      const updated = { ...current, tags };
      projects = projects.map((project) => (project.id === current.id ? updated : project));
      return updated;
    },
    updateDetails: async (projectId, details) => {
      const current = projects.find((project) => project.id === projectId) ?? projects[0]!;
      const updated = { ...current, name: details.name, description: details.note };
      projects = projects.map((project) => (project.id === current.id ? updated : project));
      return updated;
    },
    listAgentCandidates: async () => previewCandidates,
    previewDirectory: async () => previewDirectoryPreview,
    getAssemblyPlan: async () => null,
    listPhysicalTargets: async () => previewPhysicalTargets,
  };
}

const previewPicker = { pickDirectory: async () => "C:/Preview/Aurora" };

/** DEV-only projects board (/__preview/projects); never wired into production. */
export function ProjectsPreview() {
  const empty = new URLSearchParams(window.location.search).has("empty");
  const initial = useMemo(() => (empty ? [] : previewProjects), [empty]);
  const [facade] = useState(() => createPreviewProjectFacade(initial));
  return <ProjectListPage directoryPicker={previewPicker} facade={facade} />;
}
