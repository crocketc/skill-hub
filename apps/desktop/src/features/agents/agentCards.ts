import { normalizeBrandKey } from "../../ui/BrandTag";
import type { AgentCardModel } from "./agentCardModel";
import { buildAgentCardModels } from "./agentCardModel";
import type { AgentView } from "./api";

export interface AgentCardView {
  agent: AgentView;
  agents: AgentView[];
  kinds: NonNullable<AgentView["kinds"]>;
  sharedDirectory: boolean;
  sharedPathKeys: string[];
  model: AgentCardModel;
}

function directoryKey(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+?/g, "/").toLowerCase();
}
export { directoryKey as normalizePathKey };

function representative(model: AgentCardModel): AgentView {
  const primary = model.members[0];
  return {
    ...primary,
    id: model.detailTarget,
    discoveredPaths: model.directories.flatMap((directory) => directory.path ? [directory.path] : []),
    sharedReferencePaths: model.directories
      .filter((directory) => directory.sharedReference && directory.path)
      .map((directory) => directory.path as string),
    kinds: model.kinds,
    builtin: model.builtin || undefined,
    supportsSharedDirectory: model.supportsSharedDirectory,
    sharedAgentBrands: model.sharedAgentBrands,
    sharedAgentBrandKinds: model.sharedAgentBrandKinds,
    directoryViews: model.directories,
  };
}

/** Compatibility entry point; merge semantics live in AgentCardModel. */
export function buildAgentCardViews(agents: AgentView[]): Map<string, AgentCardView[]> {
  const grouped = new Map<string, AgentCardView[]>();
  for (const model of buildAgentCardModels(agents)) {
    const brand = normalizeBrandKey(model.brand);
    const card: AgentCardView = {
      agent: representative(model),
      agents: model.members,
      kinds: model.kinds,
      sharedDirectory: model.sharedDirectory,
      sharedPathKeys: model.directories
        .filter((directory) => directory.sharedReference && directory.path)
        .map((directory) => directoryKey(directory.path as string)),
      model,
    };
    const existing = grouped.get(brand) ?? [];
    existing.push(card);
    grouped.set(brand, existing);
  }
  return grouped;
}

export function countDiscoveredAgentCards(agents: AgentView[]): number {
  return buildAgentCardModels(agents.filter((agent) => agent.status !== "custom")).length;
}
