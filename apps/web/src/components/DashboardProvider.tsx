import { useEffect, useState, type ReactNode } from "react";
import { refreshOnFocus } from "../focus-refresh";
import { useSettingsStore } from "../settings-store";
import { createDashboardStore, DashboardContext } from "../store";
export function DashboardProvider({ children }: { children: ReactNode }) {
  const settings = useSettingsStore();
  const [store] = useState(() => createDashboardStore(settings));
  useEffect(
    () =>
      refreshOnFocus(async () => {
        await settings.getState().refresh();
        const id = settings.getState().snapshot.settings.activeWorkspaceId;
        if (id) await store.getState().loadViewport(id);
      }),
    [settings, store],
  );
  return (
    <DashboardContext.Provider value={store}>
      {children}
    </DashboardContext.Provider>
  );
}
