import { createContext, useEffect, useState, type ReactNode } from "react";

export const CharacterVisibilityContext = createContext(false);
export function CharacterMotionProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    function handleVisibility() { setHidden(document.hidden); }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);
  return <CharacterVisibilityContext.Provider value={hidden}>{children}</CharacterVisibilityContext.Provider>;
}
