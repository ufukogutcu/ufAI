import {
  cloneElement,
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type AnimationEvent,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import styles from "./Appearance.module.scss";

const EnteringContext = createContext(false);

// Keep rebuilt forms and result rows immediate, while allowing conditional
// fields and feedback inserted into them later to animate independently.
export function AppearanceGroup({ children }: { children: ReactNode }) {
  const parentEntering = useContext(EnteringContext);
  const [mounting, setMounting] = useState(true);
  useLayoutEffect(() => setMounting(false), []);
  return (
    <EnteringContext.Provider value={parentEntering || mounting}>
      {children}
    </EnteringContext.Provider>
  );
}

// Add motion to an existing element without changing layout or refs. Forwarding
// components (such as React Flow's Panel) must pass DOM animation props through.
// Descendants mounted during a parent's entrance skip that entrance permanently;
// later insertions and explicit trigger changes can animate independently.
export function Appearance({
  children,
  kind = "content",
  trigger,
  ready = true,
}: {
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  kind?: "content" | "selection" | "dialog" | "fade";
  trigger?: string | number | boolean | null;
  ready?: boolean;
}) {
  const parentEntering = useContext(EnteringContext);
  const [entrance, setEntrance] = useState(() => ({
    trigger,
    again: false,
    suppressed: parentEntering,
    entering: !parentEntering,
  }));
  // Reset only for an explicit presentation change, retaining the child DOM and
  // editor state. Ordinary rerenders and successful saves keep the same trigger.
  if (!Object.is(trigger, entrance.trigger)) {
    setEntrance({
      trigger,
      again: !entrance.again,
      suppressed: parentEntering,
      entering: !parentEntering,
    });
  }
  function handleAnimationEnd(event: AnimationEvent<HTMLElement>) {
    children.props.onAnimationEnd?.(event);
    const foreground = kind === "selection" &&
      event.target instanceof HTMLElement &&
      event.target.hasAttribute("data-appearance-content");
    if ((!foreground && event.target !== event.currentTarget) || event.nativeEvent.pseudoElement)
      return;
    setEntrance((current) =>
      current.entering ? { ...current, entering: false } : current,
    );
  }
  const animated = ready && !entrance.suppressed;
  const className = [
    children.props.className,
    animated ? styles.entrance : "",
    animated && entrance.again ? styles.again : "",
    animated && kind !== "content" ? styles[kind] : "",
    animated && kind === "selection" && entrance.entering ? styles.selectionActive : "",
  ].filter(Boolean).join(" ");
  return (
    <EnteringContext.Provider value={parentEntering || (ready && entrance.entering)}>
      {cloneElement(children, { className, onAnimationEnd: handleAnimationEnd })}
    </EnteringContext.Provider>
  );
}
