import { useCallback, useRef, useState, type ReactNode } from "react";
import { Dialog } from "./Dialog";

import { UnsavedContext } from "../navigation-guard";

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const dirty = useRef(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const attempt = useCallback((action: () => void) => {
    if (dirty.current) {
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
    dirty.current = false;
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
