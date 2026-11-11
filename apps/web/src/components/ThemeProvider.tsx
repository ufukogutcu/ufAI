import { useEffect, useState, type ReactNode } from "react";
import { createThemeStore, ThemeContext } from "../theme-store";
import { applyTheme, cacheTheme, type Theme } from "../themes";

export function ThemeProvider({
  initial,
  children,
}: {
  initial: Theme;
  children: ReactNode;
}) {
  const [store] = useState(() => createThemeStore(initial));
  useEffect(() => {
    applyTheme(store.getState().active);
    cacheTheme(store.getState().active);
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.active !== previous.active) applyTheme(state.active);
    });
    void store.getState().refreshActive();
    return unsubscribe;
  }, [store]);
  return (
    <ThemeContext.Provider value={store}>{children}</ThemeContext.Provider>
  );
}
