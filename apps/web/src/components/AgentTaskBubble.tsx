import { useAgentStore } from "../agent-store";
import { useNavigationGuard } from "../navigation-guard";
import { Tooltip } from "./Tooltip";
import styles from "./AgentTaskBubble.module.scss";

export function AgentTaskBubble({ agentId, workspaceId, agentName, count, chatWorking }: {
  agentId: string; workspaceId: string; agentName: string; count: number; chatWorking: boolean;
}) {
  const store = useAgentStore();
  const guard = useNavigationGuard();
  const label = `${count} ongoing ${count === 1 ? "task" : "tasks"}`;
  function openTasks(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    guard(() => {
      store.getState().setPanelTab(agentId, "Tasks");
      store.getState().select(workspaceId, agentId);
    });
  }
  function stopPointer(event: React.PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
  }
  return <Tooltip content={`${label} · Running, queued or waiting, including awaiting input.${chatWorking ? " Chat adds one while it is running or waiting." : ""} Open Tasks.`} live>
    <button type="button" className={`nodrag nopan ${styles.trigger}`}
      aria-label={`${label}${chatWorking ? " plus active Chat" : ""} for ${agentName}. Open Tasks`}
      onPointerDown={stopPointer} onClick={openTasks}>
      <span className={styles.bubble} aria-hidden="true">{chatWorking ? `${count} + 1` : count}</span>
    </button>
  </Tooltip>;
}
