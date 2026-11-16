export const agentPanelTabs = ["Details", "Chat", "Skills", "MCP", "Tasks", "Memory", "Files", "Browser"] as const;
export type AgentPanelTab = (typeof agentPanelTabs)[number];
export type AgentPanelTabs = Partial<Record<string, AgentPanelTab>>;

const storageKey = "ufai.agent-panel-tabs.v1";

export function readAgentPanelTabs(): AgentPanelTabs {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(
      (entry): entry is [string, AgentPanelTab] =>
        typeof entry[1] === "string" && agentPanelTabs.includes(entry[1] as AgentPanelTab),
    ));
  } catch {
    return {};
  }
}

export function saveAgentPanelTabs(tabs: AgentPanelTabs): void {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(tabs));
  } catch {
    // Panels still remember their tabs in the scoped store when storage is blocked.
  }
}
