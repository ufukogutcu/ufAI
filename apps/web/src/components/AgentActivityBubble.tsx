import { BookOpen, BookOpenCheck, Brain, Coffee, Laptop, Moon, Snowflake, type LucideIcon } from "lucide-react";
import type { AgentActivityStatus } from "../agent-appearance";
import { Tooltip } from "./Tooltip";
import styles from "./AgentActivityBubble.module.scss";

const appearances = {
  idle: { icon: Coffee, title: "Idle", description: "This agent has no task or Chat currently running or waiting to continue." },
  working: { icon: Laptop, title: "Working", description: "This agent is working on tasks or Chat. It may be waiting for work to continue." },
  frozen: { icon: Snowflake, title: "Frozen", description: "This agent’s execution is paused until it resumes." },
  resuming: { icon: Snowflake, title: "Preparing resume…", description: "This agent is preparing to resume and is still frozen." },
  dreaming: { icon: Moon, title: "Dreaming", description: "This agent is in its dreaming pose." },
  studying: { icon: BookOpen, title: "Studying", description: "This agent is in its studying pose." },
  "studying-hard": { icon: BookOpenCheck, title: "Studying much harder", description: "This agent is in its focused studying pose." },
  thinking: { icon: Brain, title: "Thinking", description: "This agent is in its thinking pose." },
} satisfies Record<AgentActivityStatus, { icon: LucideIcon; title: string; description: string }>;

export function AgentActivityGlyph({ status }: { status: AgentActivityStatus }) {
  const Icon = appearances[status].icon;
  return <span className={styles.bubble} data-activity={status} aria-hidden="true"><Icon size={12} /></span>;
}

export function AgentActivityBubble({ agentName, status }: { agentName: string; status: AgentActivityStatus }) {
  const { title, description } = appearances[status];
  return <Tooltip content={description} visualContent={<><strong>{title}</strong><div>{description}</div></>} live toggleOnClick>
    <button type="button" className={`nodrag nopan ${styles.trigger}`} aria-label={`${agentName}, ${title}`}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <AgentActivityGlyph status={status} />
    </button>
  </Tooltip>;
}
