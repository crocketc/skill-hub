import {
  queryApplication,
  type CustomAgent,
  type DiscoverySnapshot,
  type LogicalTarget,
} from "../../api/bindings";
import type { AgentFacade, AgentRelation, AgentView } from "./api";

function unexpectedResult(operation: string): Error {
  return new Error(`${operation} returned an unexpected native result.`);
}

function relationOf(target: LogicalTarget, snapshot: DiscoverySnapshot): AgentRelation {
  const physical = snapshot.physical_targets.find((candidate) => candidate.id === target.physical_id);
  return {
    logicalLabel: target.id,
    logicalTargetId: target.id,
    physicalPath: physical?.path ?? target.path,
    physicalTargetId: target.physical_id,
  };
}

function discoveredAgents(snapshot: DiscoverySnapshot): AgentView[] {
  return snapshot.instances.map((instance) => {
    const targets = snapshot.logical_targets.filter(
      (target) => target.profile_id === instance.profile_id && target.client_id === instance.client_id,
    );
    return {
      id: `${instance.profile_id}.${instance.client_id}`,
      brand: instance.profile_id,
      client: instance.client_id,
      instance: instance.client_id,
      discoveredPaths: [...new Set(targets.map((target) => target.path))],
      relations: targets.map((target) => relationOf(target, snapshot)),
    };
  });
}

function customAgent(agent: CustomAgent): AgentView {
  const client = agent.profile.clients[0]?.id ?? "custom";
  return {
    id: agent.id,
    brand: agent.profile.brand,
    client,
    instance: agent.display_name,
    discoveredPaths: [agent.directory.path],
    relations: [{
      logicalLabel: agent.display_name,
      logicalTargetId: agent.id,
      physicalPath: agent.directory.path,
      physicalTargetId: agent.directory.grant_id,
    }],
  };
}

async function listAgents(): Promise<AgentView[]> {
  const [discovery, custom] = await Promise.all([
    queryApplication({ type: "get_discovery_snapshot", payload: null }),
    queryApplication({ type: "list_custom_agents", payload: null }),
  ]);
  if (discovery.type !== "discovery_snapshot") throw unexpectedResult("get_discovery_snapshot");
  if (custom.type !== "custom_agents") throw unexpectedResult("list_custom_agents");
  return [...discoveredAgents(discovery.payload), ...custom.payload.map(customAgent)];
}

export const nativeAgentFacade: AgentFacade = {
  list: listAgents,
  async get(id) {
    const agent = (await listAgents()).find((candidate) => candidate.id === id);
    if (!agent) throw new Error(`Agent ${id} was not found.`);
    return agent;
  },
};
