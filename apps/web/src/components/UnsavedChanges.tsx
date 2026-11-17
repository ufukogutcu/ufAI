import { useCallback, useRef, useState, type ReactNode } from "react";
import { Dialog } from "./Dialog";

import { UnsavedContext } from "../navigation-guard";

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const dirty = useRef(new Map<symbol, (() => void) | undefined>());
  const [pending, setPending] = useState<(() => void) | null>(null);
  const setDirty = useCallback((value: boolean, owner: symbol, onDiscard?: () => void) => {
    if (value) dirty.current.set(owner, onDiscard); else dirty.current.delete(owner);
  }, []);
  const attempt = useCallback((action: () => void) => {
    if (dirty.current.size) {
      setPending(() => action);
      return false;
    }
    action();
    return true;
  }, []);
  function handleCancel() {
    setPending(null);
  }
  function handleDiscard() {
    const discard = [...dirty.current.values()];
    dirty.current.clear();
    for (const reset of discard) reset?.();
    setPending(null);
    pending?.();
  }
  return (
    <UnsavedContext.Provider value={{ setDirty, attempt }}>
      {children}
      {pending && (
        <Dialog title="Discard unsaved changes?" onClose={handleCancel}>
          <p>You have unsaved changes. Discard them to continue?</p>
          <div className="dialogActions">
            <button className="button secondary" onClick={handleCancel}>
              Keep editing
            </button>
            <button className="button danger" onClick={handleDiscard}>
              Discard changes
            </button>
          </div>
        </Dialog>
      )}
    </UnsavedContext.Provider>
  );
}
