import type characterCatalog from "@ufai/character-catalog";
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
export type ProviderPresetOptions = {
  provider: "codex";
  reasoningEffort?: string;
  serviceTier?: string;
};
export type ProviderPresetCapabilities = {
  provider: "codex";
  reasoningEfforts?: { id: string; description: string }[];
  serviceTiers?: { id: string; name: string; description: string }[];
};

export interface WorkspaceInput {
  name: string;
  description: string;
}

export interface Workspace extends WorkspaceInput {
  id: string;
  readonly sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceDuplicateInput extends WorkspaceInput {
  requestId: string;
  includeConnections: boolean;
  includeSkills: boolean;
  includeMcp: boolean;
  includeMemories: boolean;
  includeWorkspaceFiles: boolean;
  includeAgentFiles: boolean;
  includeTriggers: boolean;
}

export interface WorkspaceDuplication {
  id: string;
  sourceWorkspaceId: string;
  name: string;
  state: "pending" | "running" | "completed" | "failed";
  phase: "pending" | "copying" | "publishing" | "completed" | "failed";
  error: string | null;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PresetInput {
  name: string;
  isDefault?: boolean;
  connectionId?: string | null;
  modelId?: string | null;
  compaction?: Compaction | null;
  providerOptions?: ProviderPresetOptions | null;
}

export interface AgentModelConfiguration {
  connectionId: string | null;
  modelId: string | null;
  compaction: Compaction | null;
  providerOptions: ProviderPresetOptions | null;
}

export interface PresetConfiguration extends AgentModelConfiguration {
  name: string;
  isDefault: boolean;
  integrationKind: IntegrationKind | null;
  provider: ProviderId | null;
  customProviderName: string | null;
  contextWindow: number | null;
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
export type MediaSupport = "supported" | "unsupported" | "unknown";
export interface MediaCapabilities {
  limits?: {
    maxImageBytes?: number;
    maxTotalBytes?: number;
    imageTypes?: string[];
  };
  image: MediaSupport;
  pdf: MediaSupport;
}
export interface ModelMedia {
  discovered: MediaCapabilities;
  overrides: { image: boolean | null; pdf: boolean | null };
  effective: MediaCapabilities;
}
export interface DiscoveredModel {
  media?: MediaCapabilities;
  presetCapabilities?: ProviderPresetCapabilities;
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
  agentTotal?: number;
  agents?: { id: string; name: string; workspaceName: string }[];
  confirmationToken: string;
}
export interface ProviderModel extends DiscoveredModel {
  mediaSettings?: ModelMedia;
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
  characterAnimationsPaused: boolean;
  inboxInAppAlertsEnabled: boolean;
  inboxDesktopAlertsEnabled: boolean;
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
  "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";

export type TaskStatus =
  | "waiting"
  | "queued"
  | "running"
  | "awaiting_user"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";
export type CharacterKind = keyof typeof characterCatalog.characters;
export type CharacterColor = keyof typeof characterCatalog.colors;
export type CharacterAccessory = keyof typeof characterCatalog.accessories;
export type CharacterActivity = keyof typeof characterCatalog.activities;
export interface AgentAppearance {
  kind: CharacterKind;
  color: CharacterColor;
  accessories: CharacterAccessory[];
}
export type FreezePolicy = "all" | "skip" | "latest_per_trigger";
export interface AgentExecutionControl {
  state: "active" | "freezing" | "frozen" | "resuming";
  revision: number;
  requestedAt: string | null;
  frozenAt: string | null;
  queuedTriggerCount: number;
  backlogPending: boolean;
  workspaceHeld: boolean;
}
export interface WorkspaceExecutionControl extends Omit<AgentExecutionControl, "workspaceHeld"> {
  agentCount: number;
  resumeAgentCount: number;
  frozenAgentCount: number;
}
export interface WorkspacePacing {
  extraDelayMs: number;
  revision: number;
}
export interface Agent {
  executionControl: AgentExecutionControl;
  issueCounts: { warning: number; error: number };
  pendingUserInputCount: number;
  appearance: AgentAppearance;
  id: string;
  workspaceId: string;
  name: string;
  instructions: string;
  presetId: string | null;
  customConfiguration: AgentModelConfiguration | null;
  x: number;
  y: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  state: TaskStatus | "idle";
  queuedCount: number;
  runningTaskCount: number;
  unfinishedTaskCount: number;
}
export interface AgentTask {
  trigger?: { id: string; occurrenceId: string; name: string; scheduledAt: string; dispatchedAt: string | null };
  pendingReason?: "message" | "check_in" | "user_input" | null;
  nextCheckInAt?: string | null;
  kind: "task" | "chat";
  source?: "user" | "agent" | "system";
  rootWorkflowId?: string;
  parentRequestId?: string | null;
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
export interface AgentIssue {
  id: string;
  severity: "warning" | "error";
  message: string;
  taskId: string | null;
  taskTitle: string | null;
}
export interface AgentMessage {
  authorType?: "user" | "agent" | "system";
  authorId?: string | null;
  authorName?: string | null;
  parts?: ContentPart[];
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
  processes?: OwnedProcess[];
  agentId: string;
  capturedAt: string;
  tasks: AgentTask[];
  running: AgentTurn[];
  queuedCount: number;
  /** Retired status conversations never execute. */
  statusTurn: AgentTurn | null;
}
export interface AgentChat {
  task: AgentTask | null;
  turns: AgentTurn[];
}
export interface TaskDetail {
  task: AgentTask;
  turns: AgentTurn[];
}

export type LocationKind = "workspace" | "agent" | "task";
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
export interface AgentFileEntry {
  name: string;
  /** Slash-separated path relative to the agent's persistent files folder. */
  path: string;
  kind: "directory" | "file" | "unavailable";
  size: number | null;
  modifiedAt: string | null;
}
export interface AgentFileListing {
  path: string;
  items: AgentFileEntry[];
  total: number;
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

export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "artifact";
      versionId: string;
      name: string;
      mode?: "inspect" | "file";
    };
export interface ExecutionItem {
  sequence: number;
  id: string;
  workspaceId: string;
  agentId: string;
  taskId: string;
  turnId: string;
  kind: "commentary" | "final" | "tool_call" | "tool_result" | "artifact";
  content: string;
  createdAt: string;
}
export interface OwnedProcess {
  id: string;
  workspaceId: string;
  agentId: string;
  taskId: string;
  turnId: string;
  command: string;
  cwd: string;
  pty: number;
  launchId: string;
  state:
    | "starting"
    | "running"
    | "exited"
    | "stopped"
    | "timed_out"
    | "interrupted"
    | "failed";
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  outputStart: number;
  outputEnd: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProcessOutput {
  encoding: "base64";
  data: string;
  start: number;
  next: number;
  end: number;
  truncated: boolean;
  state: OwnedProcess["state"];
}
export interface ArtifactVersion {
  origin?: "attachment" | "legacy_output" | "user_upload" | "event_upload" | "inspection";
  id: string;
  artifactId: string;
  workspaceId: string;
  producerAgentId: string | null;
  producerTaskId: string | null;
  provenance: string;
  sourceVersionId: string | null;
  name: string;
  mediaType: string;
  size: number;
  sha256: string | null;
  state: "staging" | "ready" | "failed" | "unavailable";
  error: string | null;
  createdAt: string;
}

export interface CommunicationLink {
  /** Legacy endpoint names; the connection grants contact in both directions. */
  id: string; workspaceId: string; sourceAgentId: string; targetAgentId: string;
  sourceAnchorAngle: number; targetAnchorAngle: number;
  state: "active" | "revoking"; createdAt: string;
}
export type CommunicationAnchors = Pick<CommunicationLink, "sourceAnchorAngle" | "targetAnchorAngle">;
export interface TaskCheckIn {
  id: string;
  taskId: string;
  requestId: string | null;
  reason: string;
  dueAt: string;
  state: "scheduled" | "fired" | "cancelled";
  deliveredTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AgentRequest {
  id: string; workspaceId: string; sourceAgentId: string | null; targetAgentId: string | null;
  sourceName: string; targetName: string; sourceTaskId: string | null; targetTaskId: string | null;
  executionState?: TaskStatus|null; executionError?: string|null;
  rootWorkflowId: string; parentRequestId: string | null; kind: "request" | "notification";
  state: string; error: string | null; createdAt: string; updatedAt: string;
}
export interface CommunicationMessage {
  id: string; sequence: number; requestId: string; senderAgentId: string; senderName: string;
  senderTaskId: string | null; recipientTaskId: string | null; kind: string;
  content: string; attachments: string[]; replyToId: string | null; createdAt: string;
}
export interface InboxEntry {
  userInputRequestId?: string | null;
  id: string; workspaceId: string; agentId: string | null; agentName: string;
  taskId: string | null; content: string; attachments: string[]; readAt: string | null; createdAt: string;
}
export interface InboxNotification {
  sequence: number;
  id: string;
  workspaceId: string;
  workspaceName: string;
  agentName: string;
  preview: string;
  readAt: string | null;
}
export interface InboxNotifications {
  cursor: number;
  unreadTotal: number;
  items: InboxNotification[];
  hasMore: boolean;
}
export interface RevocationImpact {
  link: CommunicationLink; requests: AgentRequest[]; tasks: string[];
  processes: Pick<OwnedProcess,"id"|"taskId"|"command"|"state">[]; revision: string; retains: string[];
}
export interface MessagingOperation {
  id: string; workspaceId: string; linkId: string; state: "pending" | "running" | "completed" | "failed";
  error: string | null;
}

export interface MessageTransit {
  messageId: string;
  workspaceId: string;
  requestId: string;
  linkId: string;
  senderAgentId: string;
  recipientAgentId: string;
  startedAt: string;
  arrivesAt: string;
  state: "in_flight" | "arrived" | "cancelled";
}

/** Read-only presentation of a task conversation; never used as model context. */
export type TimelineStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface TimelineEntry {
  id: string;
  /** Stable ordering cursor, scoped to this task. */
  order: string;
  turnId: string | null;
  createdAt: string;
  kind: "message" | "action" | "communication" | "checkin" | "file";
  message?: AgentMessage;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: Record<string, unknown>;
  status?: TimelineStatus;
  error?: string;
  process?: OwnedProcess;
  request?: AgentRequest;
  communication?: CommunicationMessage;
  checkin?: TaskCheckIn;
  userInput?: import("./vault-types.js").UserInputRequest;
  file?: ArtifactVersion;
  contextName?: string;
}
export interface TimelinePage {
  items: TimelineEntry[];
  before: string | null;
  /** Current snapshots of explicitly watched, previously loaded entries. */
  updates: TimelineEntry[];
  removed: string[];
}
