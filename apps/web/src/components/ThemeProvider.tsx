import { useEffect, useState, type ReactNode } from "react";
import { createThemeStore, ThemeContext } from "../theme-store";
import { useSettingsStore } from "../settings-store";
import { applyTheme } from "../themes";
import { relayFavicon } from "../branding";
import type { Theme } from "../themes";

function applyActiveTheme(theme: Theme) {
  applyTheme(theme);
  const favicon = document.querySelector<HTMLLinkElement>("#ufai-favicon");
  if (favicon) favicon.href = relayFavicon(theme.colors);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const settings = useSettingsStore();
  const [store] = useState(() => createThemeStore(settings));
  useEffect(() => {
    applyActiveTheme(settings.getState().snapshot.activeTheme);
    return settings.subscribe((state, previous) => {
      if (state.snapshot.activeTheme !== previous.snapshot.activeTheme)
        applyActiveTheme(state.snapshot.activeTheme);
    });
  }, [settings]);
  return (
    <ThemeContext.Provider value={store}>{children}</ThemeContext.Provider>
  );
}
