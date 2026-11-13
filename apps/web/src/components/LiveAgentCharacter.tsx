import type { Agent } from "../../../server/src/contracts";
import { agentActivity } from "../agent-appearance";
import { useSettings } from "../settings-store";
import { AgentCharacter } from "./AgentCharacter";

export function LiveAgentCharacter({ agent, className }: { agent: Agent; className?: string }) {
  const paused = useSettings(s => s.snapshot.settings.characterAnimationsPaused);
  return <AgentCharacter appearance={agent.appearance} activity={agentActivity(agent.state)} paused={paused} className={className} decorative />;
}
