import { createContext, useMemo, useState, type ReactNode } from "react";
import { useSettings } from "../settings-store";
import { createMermaidService, type DiagramPalette } from "../mermaid-service";
import styles from "./RichText.module.scss";

export const DiagramContext = createContext<{
  service: ReturnType<typeof createMermaidService>;
  palette: DiagramPalette;
} | null>(null);

export function RichTextProvider({ children }: { children: ReactNode }) {
  const [service] = useState(() => createMermaidService(styles.staging!));
  const colors = useSettings((s) => s.snapshot.activeTheme.colors);
  const value = useMemo(() => ({
    service,
    palette: {
      surface: colors["rich-diagram-surface"],
      text: colors["rich-diagram-text"],
      border: colors["rich-diagram-border"],
      line: colors["rich-diagram-line"],
    },
  }), [service, colors]);
  return <DiagramContext.Provider value={value}>{children}</DiagramContext.Provider>;
}
