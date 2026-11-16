import { ConnectionError } from "./model-providers.js";
import { OAuthError } from "@modelcontextprotocol/client";
import type { McpAuthErrorCode } from "./mcp-types.js";

export class McpAuthError extends ConnectionError {
  constructor(
    readonly code: McpAuthErrorCode,
    message: string,
    status = 502,
  ) {
    super(message, status);
  }
}

/** Classify known SDK failures; never expose upstream bodies, URLs or descriptions. */
export function mcpAuthError(error: unknown, exchange = false): McpAuthError {
  if (error instanceof McpAuthError) return error;
  const message = error instanceof Error ? error.message : "";
  const name = error instanceof Error ? error.name : "";
  const code = error instanceof OAuthError ? error.code : undefined;
  if (
    message ===
    "Incompatible auth server: does not support dynamic client registration"
  )
    return new McpAuthError(
      "client_registration_required",
      "This server does not support automatic OAuth client registration. Register an OAuth app for this installation, then save its client ID and any required client secret in MCP settings and retry Sign In. You do not need to switch to a personal access token.",
      400,
    );
  if (code === "invalid_client" || code === "unauthorized_client")
    return new McpAuthError(
      "invalid_client",
      "The OAuth server rejected this client. Check the registered client ID, required client secret and callback URL in MCP settings, then retry Sign In.",
      400,
    );
  if (code === "invalid_scope")
    return new McpAuthError(
      "invalid_scope",
      "The OAuth server rejected the requested permissions. Check the OAuth app's permitted scopes before retrying Sign In.",
      400,
    );
  if (code === "invalid_grant")
    return new McpAuthError(
      "sign_in_expired",
      "MCP sign-in expired or its authorization code was rejected. Start Sign In again.",
      400,
    );
  if (code === "access_denied")
    return new McpAuthError(
      "sign_in_denied",
      "MCP sign-in was denied or cancelled. Start Sign In again when ready.",
      400,
    );
  if (name === "TimeoutError" || name === "AbortError")
    return new McpAuthError(
      "oauth_timeout",
      "MCP sign-in timed out or was interrupted. Check the server's availability and retry Sign In.",
    );
  return new McpAuthError(
    exchange ? "oauth_exchange_failed" : "oauth_discovery_failed",
    exchange
      ? "MCP sign-in could not be completed. Check the registered callback URL and client credentials, then start Sign In again."
      : "Cannot discover or start OAuth for this MCP server. Check the URL, OAuth support and server availability, then retry Sign In.",
  );
}
