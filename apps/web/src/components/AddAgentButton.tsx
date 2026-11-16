import { useEffect } from "react";
import { Plus } from "lucide-react";
import { useAgents } from "../agent-store";
import { useSettings } from "../settings-store";
import { AgentCharacter } from "./AgentCharacter";
import styles from "./AddAgentButton.module.scss";

export function AddAgentButton({ workspaceId, onClick }: {
  workspaceId: string;
  onClick: () => void;
}) {
  const suggestion = useAgents(s => s.appearanceSuggestions[workspaceId]);
  const load = useAgents(s => s.loadAppearanceSuggestion);
  const paused = useSettings(s => s.snapshot.settings.characterAnimationsPaused);
  useEffect(() => {
    void load(workspaceId).catch(() => {});
  }, [load, workspaceId]);
  return (
    <button type="button" className={styles.addAgent} onClick={onClick} data-paused={paused}>
      <span className={styles.preview} aria-hidden="true">
        <span className={styles.character}>
          {suggestion?.appearance
            ? <AgentCharacter appearance={suggestion.appearance} paused={paused} decorative />
            : null}
        </span>
        <span className={styles.badge} aria-hidden="true"><Plus size={12} aria-hidden="true" /></span>
      </span>
      <span>Add Agent</span>
    </button>
  );
}
