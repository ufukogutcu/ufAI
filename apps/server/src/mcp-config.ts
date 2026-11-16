import { isAbsolute } from "node:path";
import { ConnectionError } from "./model-providers.js";
import type {
  McpAuthentication,
  McpServerInput,
  McpTransport,
} from "./mcp-types.js";
import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
export interface McpConfig {
  command: string;
  args: string[];
  cwd: string;
  url: string;
  authentication: McpAuthentication;
  oauthClientId: string;
}
export interface McpSecrets {
  env: Record<string, string>;
  headers: Record<string, string>;
  oauthClientSecret?: string;
  clients?: Record<string, StoredOAuthClientInformation>;
  tokens?: StoredOAuthTokens;
}
export interface McpOAuthFlow {
  cancelled?: boolean;
  state: string;
  serverId: string;
  agentId: string;
  revision: number;
  expiresAt: number;
  redirectUrl: string;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  authorizationUrl?: string;
}
export const mcpLimits = {
  configBytes: 65536,
  responseBytes: 16 * 1024 * 1024,
  resultNodes: 10000,
  resultDepth: 32,
  inlineResultBytes: 48000,
  pageSize: 100,
  setupMs: 15000,
  idleMs: 60000,
  sessions: 32,
  requests: 16,
  connects: 4,
  previews: 20,
};
export function badMcp(message: string, status = 400): never {
  throw new ConnectionError(message, status);
}
export function mcpObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    badMcp("Provide a JSON object.");
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((k) =>
      ["__proto__", "prototype", "constructor"].includes(k),
    )
  )
    badMcp("Invalid MCP field name.");
  return object;
}
export function mcpText(
  value: unknown,
  label: string,
  maximum = 4096,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > maximum ||
    value.includes("\0")
  )
    badMcp(`Provide ${label} (up to ${maximum} characters).`);
  return value;
}
export function mcpRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    badMcp("Provide the saved MCP revision.");
  return value as number;
}
export function mcpUrl(value: unknown): string {
  const text = mcpText(value, "an MCP server URL");
  try {
    const url = new URL(text);
    if (
      url.username ||
      url.password ||
      url.hash ||
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error();
    return url.href;
  } catch {
    return badMcp(
      "Use HTTPS, or loopback HTTP, without URL credentials or a fragment.",
    );
  }
}
function secretMap(
  value: unknown,
  previous: Record<string, string>,
  headers = false,
) {
  if (value === undefined) return { ...previous };
  const map = mcpObject(value);
  if (Object.keys(map).length > 100)
    badMcp("Use at most 100 environment variables or headers.");
  const next = { ...previous };
  for (const [rawKey, v] of Object.entries(map)) {
    const key = headers ? rawKey.toLowerCase() : rawKey;
    if (
      !(
        headers ? /^[!#$%&'*+.^_`|~0-9a-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/
      ).test(key) ||
      key.length > 128 ||
      ["__proto__", "prototype", "constructor"].includes(key)
    )
      badMcp("Invalid environment variable or header name.");
    if (
      headers &&
      [
        "host",
        "content-length",
        "connection",
        "transfer-encoding",
        "mcp-session-id",
        "mcp-protocol-version",
        "content-type",
        "accept",
      ].includes(key)
    )
      badMcp("This header is managed by the MCP transport.");
    if (v === null) delete next[key];
    else {
      next[key] = mcpText(v, "a secret value", 8192, true);
      if (headers && /[\r\n]/.test(next[key]!))
        badMcp("Header values cannot contain newlines.");
    }
  }
  if (Object.keys(next).length > 100)
    badMcp("Use at most 100 saved environment variables or headers.");
  return next;
}
export function parseMcpInput(
  value: unknown,
  previous?: { config: McpConfig; secrets: McpSecrets },
) {
  const input = mcpObject(value);
  const fields: (keyof McpServerInput)[] = [
    "name",
    "transport",
    "command",
    "args",
    "cwd",
    "url",
    "authentication",
    "env",
    "headers",
    "oauthClientId",
    "oauthClientSecret",
  ];
  if (
    Object.keys(input).some((k) => !fields.includes(k as keyof McpServerInput))
  )
    badMcp("Unknown MCP configuration field.");
  if (Buffer.byteLength(JSON.stringify(input)) > mcpLimits.configBytes)
    badMcp("MCP configuration is too large.", 413);
  const name = mcpText(input.name, "a server name", 120).trim();
  if (input.transport !== "stdio" && input.transport !== "http")
    badMcp("Choose local stdio or remote HTTP.");
  const transport: McpTransport = input.transport;
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 100)
    badMcp("Provide at most 100 command arguments.");
  const authentication = input.authentication ?? "none";
  if (!["none", "headers", "oauth"].includes(String(authentication)))
    badMcp("Choose a supported authentication method.");
  const config: McpConfig = {
    command: transport === "stdio" ? mcpText(input.command, "a command") : "",
    args:
      transport === "stdio"
        ? args.map((v) => mcpText(v, "a command argument", 4096, true))
        : [],
    cwd:
      transport === "stdio" && input.cwd
        ? mcpText(input.cwd, "a working directory")
        : "",
    url: transport === "http" ? mcpUrl(input.url) : "",
    authentication:
      transport === "http" ? (authentication as McpAuthentication) : "none",
    oauthClientId:
      transport === "http" && authentication === "oauth" && input.oauthClientId
        ? mcpText(input.oauthClientId, "an OAuth client ID")
        : "",
  };
  if (config.cwd && !isAbsolute(config.cwd))
    badMcp("Use an absolute working-directory path.");
  const prior = previous?.secrets ?? { env: {}, headers: {} };
  const secrets: McpSecrets = {
    env: transport === "stdio" ? secretMap(input.env, prior.env) : {},
    headers:
      transport === "http" && authentication !== "none"
        ? secretMap(input.headers, prior.headers, true)
        : {},
  };
  if (config.authentication === "oauth") {
    if (Object.keys(secrets.headers).includes("authorization"))
      badMcp(
        "OAuth manages the Authorization header. Remove the saved header before selecting OAuth.",
      );
    secrets.oauthClientSecret =
      input.oauthClientSecret === null
        ? undefined
        : input.oauthClientSecret === undefined
          ? prior.oauthClientSecret
          : mcpText(input.oauthClientSecret, "an OAuth client secret", 8192);
    // Registration and tokens are bound to the complete connection/auth configuration.
    if (
      previous &&
      JSON.stringify(config) === JSON.stringify(previous.config) &&
      input.oauthClientSecret === undefined &&
      input.headers === undefined
    ) {
      secrets.clients = prior.clients;
      secrets.tokens = prior.tokens;
    }
  }
  if (Buffer.byteLength(JSON.stringify(secrets)) > mcpLimits.configBytes)
    badMcp("Saved MCP credentials exceed the size limit.", 413);
  return { name, transport, config, secrets };
}
export function importMcpConfig(name: string, value: unknown): McpServerInput {
  const v = mcpObject(value);
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "command",
          "args",
          "env",
          "cwd",
          "url",
          "headers",
          "type",
          "transport",
          "disabled",
        ].includes(k),
    )
  )
    badMcp(
      "Unsupported import field. Configure OAuth through the editor; environment placeholders are not expanded.",
    );
  if (v.disabled !== undefined && typeof v.disabled !== "boolean")
    badMcp("disabled must be a boolean.");
  const type = v.type ?? v.transport ?? (v.url ? "http" : "stdio");
  if (!["stdio", "http", "streamable-http"].includes(String(type)))
    badMcp("Only stdio and Streamable HTTP imports are supported.");
  const input = {
    name,
    transport: type === "stdio" ? "stdio" : "http",
    command: v.command,
    args: v.args,
    cwd: v.cwd,
    env: v.env,
    url: v.url,
    headers: v.headers,
    authentication: v.headers ? "headers" : "none",
  } as McpServerInput;
  if (/\$\{|\$env:|%[A-Za-z_]+%/.test(JSON.stringify(input)))
    badMcp(
      "Environment placeholders are unsupported. Replace them with explicit values before importing.",
    );
  parseMcpInput(input);
  return input;
}
