import characterCatalog from "@ufai/character-catalog";
import type { Node } from "@xyflow/react";
import type { Agent } from "../../server/src/contracts";
export type AgentFlowNode = Node<{ agentId: string }, "agent">;
export type WorkspaceFlowNode = AgentFlowNode;
export const AGENT_WIDTH = characterCatalog.node.width,
  AGENT_HEIGHT = characterCatalog.node.height;

export function workspaceNodes(agents: Agent[], old: WorkspaceFlowNode[]): WorkspaceFlowNode[] {
  const previous = new Map(old.map((node) => [node.id, node]));
  const nodes = agents.map((agent): AgentFlowNode => {
    const prior = previous.get(agent.id);
    return prior && prior.position.x === agent.x && prior.position.y === agent.y
      ? prior
      : {
          id: agent.id,
          type: "agent",
          position: { x: agent.x, y: agent.y },
          data: { agentId: agent.id },
          zIndex: 1,
        };
  });
  return nodes.length === old.length && nodes.every((node, i) => node === old[i]) ? old : nodes;
}
