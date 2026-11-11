import { useEffect, useState, type ReactNode } from "react";
import { createThemeStore, ThemeContext } from "../theme-store";
import { useSettingsStore } from "../settings-store";
import { applyTheme } from "../themes";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const settings = useSettingsStore();
  const [store] = useState(() => createThemeStore(settings));
  useEffect(() => {
    applyTheme(settings.getState().snapshot.activeTheme);
    return settings.subscribe((state, previous) => {
      if (state.snapshot.activeTheme !== previous.snapshot.activeTheme)
        applyTheme(state.snapshot.activeTheme);
    });
  }, [settings]);
  return (
    <ThemeContext.Provider value={store}>{children}</ThemeContext.Provider>
  );
}
