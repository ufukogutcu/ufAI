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

export interface CodexUsageWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
export interface CodexCredits {
  balance: string | null;
  hasCredits: boolean;
  unlimited: boolean;
}
export interface CodexUsageLimit {
  id: string;
  name: string | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  credits: CodexCredits | null;
  reachedType: string | null;
}
export interface CodexResetCredit {
  id: string;
  resetType: "codexRateLimits" | "unknown";
  status: "available" | "redeeming" | "redeemed" | "unknown";
  grantedAt: number | null;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}
export interface CodexUsageSnapshot {
  planType: string | null;
  defaultLimit: CodexUsageLimit | null;
  limits: CodexUsageLimit[];
  resetCredits: {
    availableCount: number;
    credits: CodexResetCredit[] | null;
  } | null;
  ordinaryUsageAllowed: boolean | null;
  fetchedAt: string;
}
export interface CodexResetInput {
  idempotencyKey: string;
  creditId?: string;
}
export type CodexResetOutcome =
  | "reset"
  | "alreadyRedeemed"
  | "nothingToReset"
  | "noCredit";

export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_user"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";
export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  instructions: string;
  clusterId: string | null;
  presetId: string | null;
  x: number;
  y: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  state: TaskStatus | "idle";
  queuedCount: number;
}
export interface AgentTask {
  id: string;
  agentId: string;
  conversationId: string;
  title: string;
  status: TaskStatus;
  summary: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AgentMessage {
  id: string;
  conversationId: string;
  turnId: string | null;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  state: "complete" | "streaming" | "incomplete";
  createdAt: string;
}
export interface AgentTurn {
  id: string;
  taskId: string | null;
  conversationId: string;
  agentId: string;
  inputMessageId: string;
  attempt: number;
  status: string;
  phase: string;
  snapshot: string | null;
  error: string | null;
  usage: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AgentMemory {
  id: string;
  agentId: string;
  key: string;
  content: string;
  kind: "preference" | "finding";
  sources: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface AgentWorkload {
  agentId: string;
  capturedAt: string;
  tasks: AgentTask[];
  running: AgentTurn[];
  queuedCount: number;
  statusTurn: AgentTurn | null;
}
export interface TaskDetail {
  task: AgentTask;
  turns: AgentTurn[];
}

export interface Cluster {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
  colorSlot: number;
  createdAt: string;
  updatedAt: string;
}
export type LocationKind = "workspace" | "cluster" | "agent" | "task";
export interface ManagedLocation {
  id: string;
  kind: LocationKind;
  ownerId: string;
  workspaceId: string;
  relativePath: string;
  path: string;
  state: "pending" | "ready" | "error";
  error: string | null;
}
export interface DeletionOperation {
  id: string;
  kind: Exclude<LocationKind, "task">;
  ownerId: string;
  workspaceId: string;
  state: "pending" | "running" | "failed" | "completed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
