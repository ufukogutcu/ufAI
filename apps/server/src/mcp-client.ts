import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpConfig, McpOAuthFlow, McpSecrets } from "./mcp-config.js";
import { badMcp, mcpLimits, mcpUrl } from "./mcp-config.js";
import type { McpTransport } from "./mcp-types.js";

/** The pinned SDK has no public no-timeout option. Only timeout=0 is intercepted;
 * setup/discovery keep real SDK timers, and request AbortSignals still cancel work.
 * Guarded by integration tests; recheck this adapter when upgrading the SDK. */
export function mcpClient(): Client {
  const client = new Client(
    { name: "ufai", version: "0.1.0" },
    { listMaxPages: 1 },
  );
  const original = Reflect.get(client, "_setupTimeout");
  if (typeof original !== "function")
    throw new Error("MCP SDK timeout compatibility changed.");
  Object.defineProperty(client, "_setupTimeout", {
    value: function (...args: unknown[]) {
      if (args[1] !== 0) return Reflect.apply(original, client, args);
    },
  });
  return client;
}
export function mcpEnvironment(overrides: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  return { ...env, ...overrides };
}
export function mcpFetch(
  fetcher: typeof fetch,
  signal: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    mcpUrl(url);
    const response = await fetcher(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    });
    if (!response.body) return response;
    const reader = response.body.getReader();
    let size = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const value = await reader.read();
          if (value.done) {
            controller.close();
            return;
          }
          size += value.value.byteLength;
          if (size > mcpLimits.responseBytes) {
            await reader.cancel();
            controller.error(new Error("MCP response exceeds the byte limit."));
          } else controller.enqueue(value.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
export function oauthProvider(options: {
  config: McpConfig;
  redirectUrl: string;
  flow?: McpOAuthFlow;
  read: () => McpSecrets;
  write: (value: McpSecrets) => void;
}): OAuthClientProvider {
  const { config, flow, read, write } = options;
  let discovery: OAuthDiscoveryState | undefined;
  let verifier: string | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: options.redirectUrl,
    clientMetadata: {
      client_name: "ufAI",
      redirect_uris: [options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: read().oauthClientSecret
        ? "client_secret_post"
        : "none",
      application_type: "native",
    },
    state() {
      if (!flow) throw new UnauthorizedError();
      return flow.state;
    },
    clientInformation(ctx) {
      const saved = read();
      if (config.oauthClientId)
        return {
          client_id: config.oauthClientId,
          ...(saved.oauthClientSecret
            ? { client_secret: saved.oauthClientSecret }
            : {}),
          ...(ctx ? { issuer: ctx.issuer } : {}),
        };
      return ctx ? saved.clients?.[ctx.issuer] : undefined;
    },
    saveClientInformation(info, ctx) {
      if (!ctx) badMcp("OAuth registration has no issuer binding.");
      const saved = read();
      const clients = { ...saved.clients, [ctx.issuer]: info };
      if (Object.keys(clients).length > 8)
        badMcp("Too many OAuth issuers. Sign out and retry.", 409);
      write({ ...saved, clients });
    },
    tokens(ctx) {
      const tokens = read().tokens;
      return !ctx || tokens?.issuer === ctx.issuer ? tokens : undefined;
    },
    saveTokens(tokens) {
      write({ ...read(), tokens });
    },
    redirectToAuthorization(url) {
      if (!flow) throw new UnauthorizedError();
      mcpUrl(url.href);
      flow.authorizationUrl = url.href;
    },
    saveCodeVerifier(value) {
      if (flow) flow.verifier = value;
      else verifier = value;
    },
    codeVerifier() {
      const value = flow?.verifier ?? verifier;
      if (!value) badMcp("OAuth sign-in expired. Start again.", 409);
      return value;
    },
    saveDiscoveryState(value) {
      if (flow) flow.discovery = value;
      else discovery = value;
    },
    discoveryState() {
      return flow?.discovery ?? discovery;
    },
    invalidateCredentials(scope) {
      const saved = read();
      if (scope === "all" || scope === "tokens") delete saved.tokens;
      if (scope === "all" || scope === "client") delete saved.clients;
      if (scope === "all" || scope === "verifier") {
        verifier = undefined;
        if (flow) flow.verifier = undefined;
      }
      if (scope === "all" || scope === "discovery") {
        discovery = undefined;
        if (flow) flow.discovery = undefined;
      }
      write(saved);
    },
  };
  return provider;
}
export function mcpTransport(options: {
  transport: McpTransport;
  config: McpConfig;
  secrets: McpSecrets;
  cwd: string;
  fetcher: typeof fetch;
  signal: AbortSignal;
  authProvider?: OAuthClientProvider;
}) {
  const { config, secrets } = options;
  if (options.transport === "stdio")
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd || options.cwd,
      env: mcpEnvironment(secrets.env),
      stderr: "ignore",
      maxBufferSize: mcpLimits.responseBytes,
    });
  const boundedFetch = mcpFetch(options.fetcher, options.signal);
  // The SDK reuses requestInit for OAuth discovery/token requests. Inject MCP
  // credentials only at the exact resource endpoint, never at the issuer.
  const scopedFetch: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).href !== config.url) return boundedFetch(input, init);
    const headers = new Headers(secrets.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    return boundedFetch(input, { ...init, headers });
  };
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { redirect: "error" },
    fetch: scopedFetch,
    authProvider: options.authProvider,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 30000,
      reconnectionDelayGrowFactor: 1.5,
    },
    onInsufficientScope: "throw",
  });
}
