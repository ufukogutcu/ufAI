import { LiveAgentCharacter } from "./LiveAgentCharacter";
import {
  memo,
  useContext,
  useState,
  useRef,
  type CSSProperties,
  type FormEvent,
} from "react";
import { CommunicationMenuAction } from "./Messaging";
import messagingStyles from "./Messaging.module.scss";
import { Handle, Position, NodeResizeControl, type NodeProps } from "@xyflow/react";
import { Ban, Check, CircleAlert, Clock, Hourglass, Layers, ListTodo, LoaderCircle, MessageCircle, MoreHorizontal, Pencil, TriangleAlert } from "lucide-react";
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
import type { Agent } from "../../../server/src/contracts";
import { useSettings } from "../settings-store";
import { CharacterVisibilityContext } from "./CharacterMotion";
import { Tooltip } from "./Tooltip";

const agentStates = {
  idle: { label: "Ready", icon: Check },
  running: { label: "Working", icon: LoaderCircle },
  queued: { label: "Queued", icon: Clock },
  waiting: { label: "Waiting", icon: Hourglass },
  awaiting_user: { label: "Awaiting input", icon: MessageCircle },
  completed: { label: "Completed", icon: Check },
  blocked: { label: "Blocked", icon: CircleAlert },
  failed: { label: "Failed", icon: TriangleAlert },
  cancelled: { label: "Cancelled", icon: Ban },
} satisfies Record<Agent["state"], { label: string; icon: typeof Check }>;

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
  const paused = useSettings(s => s.snapshot.settings.characterAnimationsPaused);
  const hidden = useContext(CharacterVisibilityContext);
  if (!agent) return null;
  const state = agentStates[agent.state];
  const StateIcon = state.icon;
  const taskLabel = `${agent.runningTaskCount} running tasks · ${agent.queuedCount} queued`;
  function selectAgent(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    guard(() => store.getState().select(agent!.workspaceId, agent!.id));
  }
  function openMenu(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setMenu(true);
  }
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
      <Handle id="in" type="target" position={Position.Left} className={messagingStyles.handle} aria-label="Receive communication permission" />
      <Handle id="out" type="source" position={Position.Right} className={messagingStyles.handle} aria-label="Grant outgoing communication permission" />
      <div className={agentStyles.nodeCard}>
        <Tooltip content={agent.name}>
          <button
            className={`nodrag ${agentStyles.nodeName}`}
            data-move="true"
            onClick={selectAgent}
          >
            {agent.name}
          </button>
        </Tooltip>
      </div>
      <Tooltip content="Canvas controls">
        <button
          className={`iconButton nodrag ${agentStyles.nodeMenu}`}
          aria-label={`Canvas controls for ${agent.name}`}
          onClick={openMenu}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <div className={agentStyles.nodeIndicators}>
        <Tooltip content={state.label} live>
          <span className={`nodrag ${agentStyles.nodeIndicator}`} tabIndex={0} role="img" aria-label={state.label}>
            <StateIcon size={14} aria-hidden="true" className={agent.state === "running" ? agentStyles.nodeSpinner : undefined} data-paused={paused || hidden} />
          </span>
        </Tooltip>
        <Tooltip content={taskLabel} live>
          <span className={`nodrag ${agentStyles.nodeIndicator}`} tabIndex={0} role="img" aria-label={taskLabel}>
            <ListTodo size={14} aria-hidden="true" />
            <span aria-hidden="true">{agent.runningTaskCount}</span>
          </span>
        </Tooltip>
        {cluster && (
          <Tooltip content={`Cluster: ${cluster.name}`}>
            <span className={`nodrag ${agentStyles.nodeIndicator} ${agentStyles.nodeCluster}`} tabIndex={0} role="img" aria-label={`Cluster: ${cluster.name}`}>
              <Layers size={14} aria-hidden="true" />
            </span>
          </Tooltip>
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
