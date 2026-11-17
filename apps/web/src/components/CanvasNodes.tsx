import { AgentInputBubble } from "./AgentInputBubble";
import { LiveAgentCharacter } from "./LiveAgentCharacter";
import { memo, useRef } from "react";
import { AgentConnectionRing } from "./ConnectionRings";
import ringStyles from "./ConnectionRings.module.scss";
import type { NodeProps } from "@xyflow/react";
import { useAgents, useAgentStore } from "../agent-store";
import type { AgentFlowNode } from "../canvas-layout";
import { useNavigationGuard } from "../navigation-guard";
import agentStyles from "./AgentPanel.module.scss";
import { Tooltip } from "./Tooltip";
import { AgentIssueBubble } from "./AgentIssues";
import { AgentTaskBubble } from "./AgentTaskBubble";

export const AgentNode = memo(function AgentNode({
  id,
  data,
}: NodeProps<AgentFlowNode>) {
  const agent = useAgents((s) => s.agents[data.agentId]),
    store = useAgentStore(),
    guard = useNavigationGuard();
  const nameButton = useRef<HTMLButtonElement>(null);
  const hasIssues = !!agent && (agent.issueCounts.warning > 0 || agent.issueCounts.error > 0 || agent.pendingUserInputCount > 0);
  if (!agent) return null;
  function selectAgent(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    guard(() => store.getState().select(agent!.workspaceId, agent!.id));
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
            ref={nameButton}
            data-move="true"
            onClick={selectAgent}
          >
            <span className={agentStyles.nodeNameText}>{agent.name}</span>
          </button>
        </Tooltip>
        <div className={agentStyles.nodeIssues}>
          <AgentInputBubble agentId={agent.id} agentName={agent.name} count={agent.pendingUserInputCount} fallbackRef={nameButton} />
          {(["warning", "error"] as const).map(severity => agent.issueCounts[severity] > 0 && (
            <AgentIssueBubble key={severity} agentId={agent.id} agentName={agent.name} severity={severity} count={agent.issueCounts[severity]} />
          ))}
        </div>
        <AgentTaskBubble agentId={agent.id} workspaceId={agent.workspaceId} agentName={agent.name} count={agent.unfinishedTaskCount} />
      </div>
    </div>
  );
});
