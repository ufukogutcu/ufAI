import type catalog from "@ufai/theme-catalog";

// Browser imports from this module must remain type-only.
export type IntegrationKind = "provider" | "runtime";
export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "xai"
  | "deepseek"
  | "mistral"
  | "groq"
  | "together"
  | "ollama"
  | "openai-compatible"
  | "codex"
  | "custom";
export type Compaction = { mode: "percentage" | "tokens"; value: number };

export interface WorkspaceInput {
  name: string;
  description: string;
}

export interface Workspace extends WorkspaceInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface PresetInput {
  name: string;
  connectionId?: string | null;
  modelId?: string | null;
  compaction?: Compaction | null;
}

export interface PresetConfiguration {
  name: string;
  integrationKind: IntegrationKind | null;
  provider: ProviderId | null;
  customProviderName: string | null;
  modelId: string | null;
  contextWindow: number | null;
  connectionId: string | null;
  compaction: Compaction | null;
}

export interface ModelPreset extends PresetConfiguration {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type ConnectionProvider = Exclude<ProviderId, "custom">;
export interface ConnectionInput {
  provider: ConnectionProvider;
  name: string;
  endpoint?: string | null;
  apiKey?: string;
  draft?: boolean;
  modelSelection?: ModelSelection[];
  confirmationToken?: string;
}
export interface ProviderConnection {
  id: string;
  provider: ConnectionProvider;
  name: string;
  endpoint: string | null;
  hasCredential: boolean;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow: number | null;
}
export interface ModelTestResult {
  success: boolean;
  testedAt: string;
  durationMs: number;
  reply: string;
  error: string | null;
}
export interface ModelSelection {
  id: string;
  enabled: boolean;
}
export interface SelectionImpact {
  total: number;
  presets: { id: string; name: string }[];
  confirmationToken: string;
}
export interface ProviderModel extends DiscoveredModel {
  enabled: boolean;
  connectionId: string;
  discoveredContextWindow: number | null;
  contextWindowOverride: number | null;
  manual: boolean;
  available: boolean;
  lastTest: ModelTestResult | null;
  legacyLimits: {
    contextWindow: number | null;
  }[];
}
export interface CodexLoginStatus {
  status: "disconnected" | "pending" | "connected" | "error";
  authUrl?: string;
  userCode?: string;
  error?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface ApiError {
  error: string;
  selectionImpact?: SelectionImpact;
  fields?: Record<string, string>;
}

export type ThemeMode = "light" | "dark";
export type ThemeColorKey = keyof typeof catalog.tokens;
export type ThemeColors = Record<ThemeColorKey, string>;
export interface ThemeInput {
  name: string;
  mode: ThemeMode;
  colors: ThemeColors;
}
export interface Theme extends ThemeInput {
  id: string;
  builtIn: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AppSettings {
  activeThemeId: string;
  activeWorkspaceId: string | null;
  sidebarExpanded: boolean;
}
export interface SettingsResponse {
  settings: AppSettings;
  activeTheme: Theme;
  activeWorkspace: Workspace | null;
}
export interface WorkspaceViewport {
  x: number;
  y: number;
  zoom: number;
}
