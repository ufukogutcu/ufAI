/** Browser-safe MCP contracts. Import as types from the browser. */
export type McpTransport = "stdio" | "http";
export type McpAuthentication = "none" | "headers" | "oauth";
export type McpStatus =
  "not_connected" | "connecting" | "connected" | "auth_required" | "error";
export type McpCapabilityKind = "tools" | "resources" | "templates" | "prompts";
export type McpAuthErrorCode =
  | "client_registration_required"
  | "invalid_client"
  | "invalid_scope"
  | "sign_in_expired"
  | "sign_in_denied"
  | "oauth_timeout"
  | "oauth_discovery_failed"
  | "oauth_exchange_failed";
export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  authentication?: McpAuthentication;
  /** Omitted values preserve saved secrets; null removes an individual value. */
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
  oauthClientId?: string;
  oauthClientSecret?: string | null;
}
export interface McpServerSummary {
  id: string;
  name: string;
  transport: McpTransport;
  revision: number;
  enabled: boolean;
  status: McpStatus;
  error: string | null;
  authenticated: boolean;
  authErrorCode?: McpAuthErrorCode;
  authPending?: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface McpServerDetail extends McpServerSummary {
  command: string;
  args: string[];
  cwd: string;
  url: string;
  authentication: McpAuthentication;
  envKeys: string[];
  headerKeys: string[];
  oauthClientId: string;
  hasOAuthClientSecret: boolean;
  oauthRedirectUrl?: string;
  enabledAgents: { id: string; name: string; workspaceId: string }[];
}
export interface McpServerPage {
  items: McpServerSummary[];
  total: number;
}
export interface McpCapabilityPage {
  items: Record<string, unknown>[];
  nextCursor?: string;
}
export interface McpAuthStatus {
  status: McpStatus;
  authenticated: boolean;
  authorizationUrl?: string;
  redirectUrl?: string;
}
export interface McpImportPreview {
  id: string;
  expiresAt: string;
  candidates: {
    key: string;
    name: string;
    transport?: McpTransport;
    disabled?: boolean;
    existingId: string | null;
    expectedRevision?: number;
    error: string | null;
  }[];
}
