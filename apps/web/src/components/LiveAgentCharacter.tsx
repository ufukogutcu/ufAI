import type { Agent } from "../../../server/src/contracts";
import { resolveAgentCharacterState } from "../agent-appearance";
import { useSettings } from "../settings-store";
import { AgentCharacter } from "./AgentCharacter";

export function LiveAgentCharacter({ agent, className, carried = false }: { agent: Agent; className?: string; carried?: boolean }) {
  const paused = useSettings(s => s.snapshot.settings.characterAnimationsPaused);
  const { activity, frozen } = resolveAgentCharacterState(agent);
  const carry = carried ? (paused ? "static" : "animated") : undefined;
  return <AgentCharacter appearance={agent.appearance} frozen={frozen} activity={activity} carry={carry}
    paused={paused} className={className} decorative />;
}
