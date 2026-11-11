import { createContext, useContext, useEffect } from "react";
interface Guard {
  setDirty: (dirty: boolean) => void;
  attempt: (action: () => void) => boolean;
}
export const UnsavedContext = createContext<Guard | null>(null);
export function useNavigationGuard() {
  const context = useContext(UnsavedContext);
  if (!context) throw new Error("UnsavedChangesProvider is missing.");
  return context.attempt;
}
export function useUnsavedChanges(dirty: boolean) {
  const context = useContext(UnsavedContext);
  if (!context) throw new Error("UnsavedChangesProvider is missing.");
  const setDirty = context.setDirty;
  useEffect(() => {
    setDirty(dirty);
    function handleUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    if (dirty) window.addEventListener("beforeunload", handleUnload);
    return () => {
      setDirty(false);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [dirty, setDirty]);
}
