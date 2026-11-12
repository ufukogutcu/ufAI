import type { Node } from "@xyflow/react";
import type { Agent, Cluster } from "../../server/src/contracts";
export type AgentFlowNode = Node<{ agentId: string }, "agent">;
export type ClusterFlowNode = Node<{ clusterId: string }, "cluster">;
export type WorkspaceFlowNode = AgentFlowNode | ClusterFlowNode;
export const AGENT_WIDTH = 224,
  AGENT_HEIGHT = 104,
  CLUSTER_HEADER = 48;
export function dropCluster(clusters: Cluster[], x: number, y: number) {
  const cx = x + AGENT_WIDTH / 2,
    cy = y + AGENT_HEIGHT / 2;
  return (
    clusters
      .filter(
        (c) =>
          cx >= c.x &&
          cx <= c.x + c.width &&
          cy >= c.y + CLUSTER_HEADER &&
          cy <= c.y + c.height,
      )
      .sort(
        (a, b) =>
          a.width * a.height - b.width * b.height || a.id.localeCompare(b.id),
      )[0]?.id ?? null
  );
}
export function workspaceNodes(
  agents: Agent[],
  clusters: Cluster[],
  old: WorkspaceFlowNode[],
): WorkspaceFlowNode[] {
  const previous = new Map(old.map((n) => [n.id, n]));
  const groups: WorkspaceFlowNode[] = clusters.map((c) => {
    const prior = previous.get(c.id);
    return prior?.type === "cluster" &&
      prior.position.x === c.x &&
      prior.position.y === c.y &&
      prior.width === c.width &&
      prior.height === c.height
      ? prior
      : {
          id: c.id,
          type: "cluster",
          position: { x: c.x, y: c.y },
          width: c.width,
          height: c.height,
          style: { width: c.width, height: c.height },
          data: { clusterId: c.id },
          dragHandle: ".clusterDragHandle",
          zIndex: 0,
        };
  });
  const members: WorkspaceFlowNode[] = agents.map((a) => {
    const parent = clusters.find((c) => c.id === a.clusterId),
      x = a.x - (parent?.x ?? 0),
      y = a.y - (parent?.y ?? 0),
      prior = previous.get(a.id);
    return prior?.type === "agent" &&
      prior.position.x === x &&
      prior.position.y === y &&
      prior.parentId === parent?.id
      ? prior
      : {
          id: a.id,
          type: "agent",
          position: { x, y },
          data: { agentId: a.id },
          parentId: parent?.id,
          zIndex: 1,
        };
  });
  const nodes = [...groups, ...members];
  return nodes.length === old.length && nodes.every((n, i) => n === old[i])
    ? old
    : nodes;
}
