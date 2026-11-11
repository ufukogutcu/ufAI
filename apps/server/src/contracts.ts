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
  integrationKind: IntegrationKind;
  provider: ProviderId;
  customProviderName: string | null;
  modelId: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  connectionId: string | null;
  compaction: Compaction;
}

export interface ModelPreset extends PresetInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type ConnectionProvider = Exclude<ProviderId, "ollama" | "custom">;
export interface ConnectionInput {
  provider: ConnectionProvider;
  name: string;
  endpoint?: string | null;
  apiKey?: string;
  isDefault?: boolean;
}
export interface ProviderConnection {
  id: string;
  provider: ConnectionProvider;
  name: string;
  endpoint: string | null;
  isDefault: boolean;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
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
