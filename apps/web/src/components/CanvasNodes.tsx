import { FrozenIndicator, useAgentFreeze } from "./AgentFreeze";
import { AgentActivityBubble } from "./AgentActivityBubble";
import { AgentInputBubble } from "./AgentInputBubble";
import { LiveAgentCharacter } from "./LiveAgentCharacter";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, ListTodo, MessageSquare, Pencil, Settings2, Snowflake, Trash2 } from "lucide-react";
import { AgentConnectionRing } from "./ConnectionRings";
import ringStyles from "./ConnectionRings.module.scss";
import { useStoreApi, type NodeProps } from "@xyflow/react";
import { useAgents, useAgentStore } from "../agent-store";
import { resolveAgentCharacterState } from "../agent-appearance";
import type { AgentFlowNode } from "../canvas-layout";
import { useNavigationGuard } from "../navigation-guard";
import agentStyles from "./AgentPanel.module.scss";
import { Tooltip } from "./Tooltip";
import { AgentIssueBubble } from "./AgentIssues";
import { AgentTaskBubble } from "./AgentTaskBubble";
import { ContextMenu, type ContextMenuAnchor } from "./ContextMenu";
import { CharacterEditor } from "./CharacterEditor";
import { AgentDeleteDialog } from "./AgentDeleteDialog";
import type { AgentPanelTab } from "../agent-panel-tabs";

const movementSteps: Record<string, [number, number]> = {
  ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16],
};

export const AgentNode = memo(function AgentNode({
  id,
  data,
}: NodeProps<AgentFlowNode>) {
  const agent = useAgents((s) => s.agents[data.agentId]),
    store = useAgentStore(),
    guard = useNavigationGuard();
  const freeze = useAgentFreeze(agent);
  const nameButton = useRef<HTMLButtonElement>(null);
  const flowStore = useStoreApi();
  const [menu, setMenu] = useState<ContextMenuAnchor | null>(null);
  const [editingCharacter, setEditingCharacter] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(() => {
    if (!menu) return;
    const initial = flowStore.getState(), position = initial.nodeLookup.get(id)?.internals.positionAbsolute;
    const x = position?.x, y = position?.y;
    return flowStore.subscribe(state => {
      const current = state.nodeLookup.get(id)?.internals.positionAbsolute;
      if (state.transform !== initial.transform || current?.x !== x || current?.y !== y) closeMenu();
    });
  }, [menu, flowStore, id, closeMenu]);
  const hasIssues = !!agent && (agent.issueCounts.warning > 0 || agent.issueCounts.error > 0 || agent.pendingUserInputCount > 0);
  if (!agent) return null;
  function openTab(tab: AgentPanelTab) {
    guard(() => {
      store.getState().setPanelTab(agent!.id, tab);
      store.getState().select(agent!.workspaceId, agent!.id);
    });
  }
  function contextMenu(event: React.MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    const trigger = nameButton.current!;
    trigger.focus({ preventScroll: true });
    setMenu({ x: event.clientX, y: event.clientY, returnFocus: trigger });
  }
  function selectAgent(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    guard(() => store.getState().select(agent!.workspaceId, agent!.id));
  }
  function keyboard(event: React.KeyboardEvent) {
    if (event.target === nameButton.current && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      event.stopPropagation();
      const trigger = nameButton.current!, rect = trigger.getBoundingClientRect();
      setMenu({ x: rect.left, y: rect.bottom, returnFocus: trigger });
      return;
    }
    const step = movementSteps[event.key];
    if (
      step &&
      event.target === nameButton.current
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
      onContextMenu={contextMenu}
    >
      <div className={agentStyles.canvasCharacter}><LiveAgentCharacter agent={agent} /></div>
      <AgentConnectionRing id={id} name={agent.name} workspaceId={agent.workspaceId} />
      <div className={agentStyles.nodeCard}>
        <Tooltip content={menu ? "" : agent.name}>
          <button
            type="button"
            className={`nodrag ${agentStyles.nodeName}`}
            ref={nameButton}
            data-move="true"
            aria-haspopup="menu"
            aria-expanded={!!menu || undefined}
            onClick={selectAgent}
          >
            {agent.executionControl?.state === "freezing" && <FrozenIndicator agent={agent} />}
            <span className={agentStyles.nodeNameText}>{agent.name}</span>
          </button>
        </Tooltip>
        <AgentActivityBubble agentName={agent.name} status={resolveAgentCharacterState(agent).status} />
        <div className={agentStyles.nodeIssues}>
          <AgentInputBubble agentId={agent.id} agentName={agent.name} count={agent.pendingUserInputCount} fallbackRef={nameButton} />
          {(["warning", "error"] as const).map(severity => agent.issueCounts[severity] > 0 && (
            <AgentIssueBubble key={severity} agentId={agent.id} agentName={agent.name} severity={severity} count={agent.issueCounts[severity]} />
          ))}
        </div>
        <AgentTaskBubble agentId={agent.id} workspaceId={agent.workspaceId} agentName={agent.name}
          count={agent.unfinishedTaskCount} chatWorking={agent.chatWorking} />
      </div>
      {menu && <ContextMenu anchor={menu} label={`Actions for ${agent.name}`} onClose={closeMenu} items={[
        { id: "chat", label: "Open Chat", icon: <MessageSquare size={16} />, onSelect: () => openTab("Chat") },
        { id: "details", label: "Edit details…", icon: <Settings2 size={16} />, onSelect: () => openTab("Details") },
        { id: "tasks", label: "Open Tasks", icon: <ListTodo size={16} />, onSelect: () => openTab("Tasks") },
        { id: "files", label: "Open Files", icon: <FolderOpen size={16} />, onSelect: () => openTab("Files") },
        { id: "character", label: "Edit character…", icon: <Pencil size={16} />, onSelect: () => guard(() => setEditingCharacter(true)) },
        { id: "freeze", label: freeze.label, icon: <Snowflake size={16} />, disabled: freeze.pending, onSelect: freeze.activate },
        { id: "separator", separator: true },
        { id: "delete", label: "Delete Agent…", icon: <Trash2 size={16} />, destructive: true, onSelect: () => guard(() => setDeleting(true)) },
      ]} />}
      {freeze.dialog}
      {editingCharacter && <CharacterEditor initial={agent.appearance} onClose={() => setEditingCharacter(false)}
        onSave={async appearance => { await store.getState().update(agent.id, { appearance }); }} />}
      {deleting && <AgentDeleteDialog agent={agent} onClose={() => setDeleting(false)} />}
    </div>
  );
});
