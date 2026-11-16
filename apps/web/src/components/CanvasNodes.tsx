import { LiveAgentCharacter } from "./LiveAgentCharacter";
import {
  memo,
  useContext,
  useState,
} from "react";
import { CommunicationMenuAction } from "./Messaging";
import { AgentConnectionRing } from "./ConnectionRings";
import ringStyles from "./ConnectionRings.module.scss";
import type { NodeProps } from "@xyflow/react";
import { Ban, Check, CircleAlert, Clock, Hourglass, ListTodo, LoaderCircle, MessageCircle, MoreHorizontal, TriangleAlert } from "lucide-react";
import { useAgents, useAgentStore } from "../agent-store";
import type { AgentFlowNode } from "../canvas-layout";
import { useNavigationGuard } from "../navigation-guard";
import { errorMessage } from "../api";
import { Dialog } from "./Dialog";
import styles from "./ManagedFiles.module.scss";
import agentStyles from "./AgentPanel.module.scss";
import type { Agent } from "../../../server/src/contracts";
import { useSettings } from "../settings-store";
import { CharacterVisibilityContext } from "./CharacterMotion";
import { Tooltip } from "./Tooltip";
import { AgentIssueBubble } from "./AgentIssues";

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

function NodeActions({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose: () => void;
}) {
  const store = useAgentStore();
  const agent = useAgents((s) => s.agents[agentId]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
    if (agent) await store.getState().moveAgent(agent.id, agent.x + dx, agent.y + dy);
  }
  return (
    <Dialog
      title="Agent canvas controls"
      onClose={onClose}
      busy={busy}
    >
      <p>{agent?.name}</p>
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
      {agent && <CommunicationMenuAction workspaceId={agent.workspaceId} sourceAgentId={agent.id} onDone={onClose} />}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
export const AgentNode = memo(function AgentNode({
  id,
  data,
}: NodeProps<AgentFlowNode>) {
  const agent = useAgents((s) => s.agents[data.agentId]),
    store = useAgentStore(),
    guard = useNavigationGuard();
  const [menu, setMenu] = useState(false);
  const paused = useSettings(s => s.snapshot.settings.characterAnimationsPaused);
  const hidden = useContext(CharacterVisibilityContext);
  const hasIssues = !!agent && (agent.issueCounts.warning > 0 || agent.issueCounts.error > 0);
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
        y = agent!.y + step[1];
      void store
        .getState()
        .moveAgent(agent!.id, x, y)
        .catch(() => {});
    }
  }
  return (
    <div
      className={`${agentStyles.node} ${ringStyles.agent}`}
      data-issues={hasIssues}
      onKeyDown={keyboard}
    >
      <div className={agentStyles.canvasCharacter}><LiveAgentCharacter agent={agent} /></div>
      <AgentConnectionRing id={id} name={agent.name} workspaceId={agent.workspaceId} />
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
        <div className={agentStyles.nodeIssues}>
          {(["warning", "error"] as const).map(severity => agent.issueCounts[severity] > 0 && (
            <AgentIssueBubble key={severity} agentId={agent.id} agentName={agent.name} severity={severity} count={agent.issueCounts[severity]} />
          ))}
        </div>
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
      </div>
      {menu && (
        <NodeActions agentId={agent.id} onClose={() => setMenu(false)} />
      )}
    </div>
  );
});
