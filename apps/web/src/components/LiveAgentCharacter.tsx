import type { Agent } from "../../../server/src/contracts";
import { resolveAgentCharacterState } from "../agent-appearance";
import { useSettings } from "../settings-store";
import { AgentCharacter } from "./AgentCharacter";

export function LiveAgentCharacter({ agent, className }: { agent: Agent; className?: string }) {
  const paused = useSettings(s => s.snapshot.settings.characterAnimationsPaused);
  const { activity, frozen } = resolveAgentCharacterState(agent);
  return <AgentCharacter appearance={agent.appearance} frozen={frozen} activity={activity} paused={paused} className={className} decorative />;
}
