import { createContext, useContext, useEffect, useRef } from "react";
interface Guard {
  setDirty: (dirty: boolean, owner: symbol, onDiscard?: () => void) => void;
  attempt: (action: () => void) => boolean;
}
export const UnsavedContext = createContext<Guard | null>(null);
export function useNavigationGuard() {
  const context = useContext(UnsavedContext);
  if (!context) throw new Error("UnsavedChangesProvider is missing.");
  return context.attempt;
}
export function useUnsavedChanges(dirty: boolean, onDiscard?: () => void) {
  const context = useContext(UnsavedContext);
  if (!context) throw new Error("UnsavedChangesProvider is missing.");
  const setDirty = context.setDirty;
  const owner = useRef(Symbol("unsaved draft"));
  useEffect(() => {
    setDirty(dirty, owner.current, onDiscard);
    function handleUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    if (dirty) window.addEventListener("beforeunload", handleUnload);
    return () => {
      setDirty(false, owner.current);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [dirty, setDirty, onDiscard]);
}
