import { LiveAgentCharacter } from "./LiveAgentCharacter";
import {
  memo,
  useState,
  useRef,
  type CSSProperties,
  type FormEvent,
} from "react";
import { CommunicationMenuAction } from "./Messaging";
import messagingStyles from "./Messaging.module.scss";
import { Handle, Position, NodeResizeControl, type NodeProps } from "@xyflow/react";
import { MoreHorizontal, Pencil } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAgents, useAgentStore } from "../agent-store";
import {
  dropCluster,
  type AgentFlowNode,
  type ClusterFlowNode,
} from "../canvas-layout";
import { useNavigationGuard } from "../navigation-guard";
import { errorMessage } from "../api";
import { clusterColors } from "../cluster-colors";
import { Dialog } from "./Dialog";
import styles from "./Clusters.module.scss";
import agentStyles from "./AgentPanel.module.scss";

export function clusterColor(slot: number): CSSProperties {
  return {
    "--cluster-color": clusterColors[slot] ?? clusterColors[0],
  } as CSSProperties;
}
function NodeActions({
  agentId,
  clusterId,
  onClose,
}: {
  agentId?: string;
  clusterId?: string;
  onClose: () => void;
}) {
  const store = useAgentStore();
  const agent = useAgents((s) => (agentId ? s.agents[agentId] : undefined));
  const cluster = useAgents((s) =>
    clusterId ? s.clusters[clusterId] : undefined,
  );
  const workspaceId = agent?.workspaceId ?? cluster!.workspaceId;
  const clusters = useAgents(
    useShallow((s) =>
      Object.values(s.clusters).filter((c) => c.workspaceId === workspaceId),
    ),
  );
  const [target, setTarget] = useState(agent?.clusterId ?? ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(cluster?.width ?? 600),
    [height, setHeight] = useState(cluster?.height ?? 360);
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function move(dx: number, dy: number) {
    if (agent) {
      const x = agent.x + dx,
        y = agent.y + dy;
      await store
        .getState()
        .moveAgent(agent.id, x, y, dropCluster(clusters, x, y));
    } else if (cluster)
      await store
        .getState()
        .updateCluster(cluster.id, { x: cluster.x + dx, y: cluster.y + dy });
  }
  async function assign() {
    if (!agent) return;
    const group = clusters.find((c) => c.id === target);
    const x = group
      ? group.x + 24
      : Math.max(agent.x, ...clusters.map((c) => c.x + c.width)) + 32;
    const y = group ? group.y + 72 : agent.y;
    await store.getState().moveAgent(agent.id, x, y, group?.id ?? null);
    onClose();
  }
  function resize(e: FormEvent) {
    e.preventDefault();
    void action(() =>
      store.getState().updateCluster(cluster!.id, { width, height }),
    );
  }
  return (
    <Dialog
      title={`${agent ? "Agent" : "Cluster"} canvas controls`}
      onClose={onClose}
      busy={busy}
    >
      <p>{agent?.name ?? cluster?.name}</p>
      <div className={styles.moveButtons}>
        {(
          [
            ["←", -16, 0, "left"],
            ["↑", 0, -16, "up"],
            ["↓", 0, 16, "down"],
            ["→", 16, 0, "right"],
          ] as const
        ).map(([label, dx, dy, name]) => (
          <button
            key={name}
            className="button secondary"
            disabled={busy}
            aria-label={`Move ${name}`}
            onClick={() => void action(() => move(dx, dy))}
          >
            {label}
          </button>
        ))}
      </div>
      {agent ? (
        <div className={styles.menuFields}>
          <CommunicationMenuAction workspaceId={workspaceId} sourceAgentId={agent.id} onDone={onClose}/>
          <label>
            Move to Cluster
            <select
              value={target}
              disabled={busy}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Outside all Clusters</option>
              {clusters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void action(assign)}
          >
            {target ? "Move to Cluster" : "Move out"}
          </button>
        </div>
      ) : (
        <form onSubmit={resize} className={styles.menuFields}>
          <label>
            Width
            <input
              type="number"
              name="clusterWidth"
              min={320}
              max={1000000}
              required
              value={width}
              disabled={busy}
              onChange={(e) => setWidth(e.target.valueAsNumber)}
            />
          </label>
          <label>
            Height
            <input
              type="number"
              name="clusterHeight"
              min={200}
              max={1000000}
              required
              value={height}
              disabled={busy}
              onChange={(e) => setHeight(e.target.valueAsNumber)}
            />
          </label>
          <button className="button primary" disabled={busy}>
            Resize Cluster
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
export const AgentNode = memo(function AgentNode({
  data,
}: NodeProps<AgentFlowNode>) {
  const agent = useAgents((s) => s.agents[data.agentId]),
    store = useAgentStore(),
    guard = useNavigationGuard();
  const cluster = useAgents((s) =>
    agent?.clusterId ? s.clusters[agent.clusterId] : undefined,
  );
  const [menu, setMenu] = useState(false);
  if (!agent) return null;
  function keyboard(event: React.KeyboardEvent) {
    const direction: Record<string, [number, number]> = {
      ArrowLeft: [-16, 0],
      ArrowRight: [16, 0],
      ArrowUp: [0, -16],
      ArrowDown: [0, 16],
    };
    const step = direction[event.key];
    if (
      step &&
      event.target instanceof HTMLButtonElement &&
      event.target.dataset.move === "true"
    ) {
      event.preventDefault();
      event.stopPropagation();
      const x = agent!.x + step[0],
        y = agent!.y + step[1],
        clusters = Object.values(store.getState().clusters).filter(
          (c) => c.workspaceId === agent!.workspaceId,
        );
      void store
        .getState()
        .moveAgent(agent!.id, x, y, dropCluster(clusters, x, y))
        .catch(() => {});
    }
  }
  return (
    <div
      className={agentStyles.node}
      onKeyDown={keyboard}
      style={cluster ? clusterColor(cluster.colorSlot) : undefined}
    >
      <div className={agentStyles.canvasCharacter}><LiveAgentCharacter agent={agent} /></div>
      <div className={agentStyles.nodeCard}>
      <Handle id="in" type="target" position={Position.Left} className={messagingStyles.handle} aria-label="Receive communication permission"/>
      <Handle id="out" type="source" position={Position.Right} className={messagingStyles.handle} aria-label="Grant outgoing communication permission"/>
      <button
        className={`nodrag ${styles.agentName}`}
        data-move="true"
        title={agent.name}
        onClick={(event) => {
          event.stopPropagation();
          guard(() => store.getState().select(agent.workspaceId, agent.id));
        }}
      >
        {agent.name}
      </button>
      <button
        className={`iconButton nodrag ${styles.nodeMenu}`}
        aria-label={`Canvas controls for ${agent.name}`}
        onClick={(event) => {
          event.stopPropagation();
          setMenu(true);
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      <p>
        {agent.state === "running"
          ? "Working"
          : agent.state === "queued"
            ? "Queued"
            : agent.state === "idle"
              ? "Ready"
              : agent.state.replaceAll("_", " ")}{" "}
        · {agent.queuedCount} queued
      </p>
      {cluster && (
        <div className={styles.member} title={`Cluster: ${cluster.name}`}>
          <span className={styles.dot} aria-hidden="true" />
          <span>Cluster: {cluster.name}</span>
        </div>
      )}
      </div>
      {menu && (
        <NodeActions agentId={agent.id} onClose={() => setMenu(false)} />
      )}
    </div>
  );
});
export const ClusterNode = memo(function ClusterNode({
  data,
  selected,
}: NodeProps<ClusterFlowNode>) {
  const cluster = useAgents((s) => s.clusters[data.clusterId]),
    store = useAgentStore(),
    guard = useNavigationGuard();
  const drop = useAgents((s) => s.dropTarget === data.clusterId),
    [menu, setMenu] = useState(false);
  const resizeGeneration = useRef(0);
  if (!cluster) return null;
  return (
    <div
      className={styles.group}
      style={clusterColor(cluster.colorSlot)}
      data-drop={drop}
    >
      <header className={`${styles.groupHeader} clusterDragHandle`}>
        <span className={styles.dot} aria-hidden="true" />
        <button
          onClick={(e) => {
            e.stopPropagation();
            guard(() =>
              store.setState((s) => ({
                selectedCluster: cluster.id,
                selected: { ...s.selected, [cluster.workspaceId]: null },
              })),
            );
          }}
          title={cluster.name}
        >
          {cluster.name}
        </button>
        <button
          className="iconButton nodrag"
          aria-label={`Edit Cluster ${cluster.name}`}
          onClick={(e) => {
            e.stopPropagation();
            guard(() =>
              store.setState((s) => ({
                selectedCluster: cluster.id,
                selected: { ...s.selected, [cluster.workspaceId]: null },
              })),
            );
          }}
        >
          <Pencil size={14} />
        </button>
        <button
          className="iconButton nodrag"
          aria-label={`Canvas controls for ${cluster.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setMenu(true);
          }}
        >
          <MoreHorizontal size={16} />
        </button>
      </header>
      {selected && (
        <NodeResizeControl
          position="bottom-right"
          minWidth={320}
          minHeight={200}
          className={styles.resize}
          onResizeStart={() => {
            resizeGeneration.current = store
              .getState()
              .beginCanvasInteraction();
          }}
          onResizeEnd={(_e, params) => {
            const generation = resizeGeneration.current;
            void store
              .getState()
              .updateCluster(cluster.id, {
                width: params.width,
                height: params.height,
              })
              .catch((e) => store.setState({ positionError: errorMessage(e) }))
              .finally(() => store.getState().endCanvasInteraction(generation));
          }}
        />
      )}
      {menu && (
        <NodeActions clusterId={cluster.id} onClose={() => setMenu(false)} />
      )}
    </div>
  );
});
