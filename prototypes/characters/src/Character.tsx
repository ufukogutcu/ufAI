import type { ComponentProps } from "react";
import { AgentCharacter } from "../../../apps/web/src/components/AgentCharacter";
import { activities } from "../../../apps/web/src/agent-appearance";

export * from "../../../apps/web/src/agent-appearance";

const carried = {
  id: "carried",
  name: "Carried",
  description: "Lifted from behind, with feet off the ground and arms hanging loose.",
} as const;

export const previewAnimations = [...activities, carried];
export type PreviewAnimation = (typeof previewAnimations)[number]["id"];

type CharacterProps = Omit<ComponentProps<typeof AgentCharacter>, "activity" | "carry"> & {
  animation?: PreviewAnimation;
};

export function Character({ animation = "idle", ...props }: CharacterProps) {
  if (animation === "carried") return <AgentCharacter {...props} carry="animated" />;
  return <AgentCharacter {...props} activity={animation} />;
}
