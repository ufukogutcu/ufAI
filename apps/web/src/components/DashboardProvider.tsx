import { useEffect, useState, type ReactNode } from "react";
import { AgentContext, createAgentStore } from "../agent-store";
import { refreshOnFocus } from "../focus-refresh";
import { useSettingsStore } from "../settings-store";
import { createDashboardStore, DashboardContext } from "../store";
export function DashboardProvider({ children }: { children: ReactNode }) {
  const settings = useSettingsStore();
  const [agents] = useState(createAgentStore);
  const [store] = useState(() => createDashboardStore(settings));
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        Object.values(agents.getState().drafts).some((value) => value.trim())
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [agents]);
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
      <AgentContext.Provider value={agents}>{children}</AgentContext.Provider>
    </DashboardContext.Provider>
  );
}
