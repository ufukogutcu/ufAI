import { useState, type ReactNode } from "react";
import { createDashboardStore, DashboardContext } from "../store";
export function DashboardProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createDashboardStore);
  return (
    <DashboardContext.Provider value={store}>
      {children}
    </DashboardContext.Provider>
  );
}
