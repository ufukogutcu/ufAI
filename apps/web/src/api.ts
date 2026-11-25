import type { ApiError, Page } from "../../server/src/contracts";
export type {
  Workspace,
  ModelPreset,
  AgentModelConfiguration,
  PresetInput,
  ProviderPresetOptions,
  ProviderId,
  IntegrationKind,
  Compaction,
  ProviderConnection,
  ConnectionInput,
  ConnectionProvider,
  DiscoveredModel,
  ProviderModel,
  ProviderModelPage,
  ModelSelection,
  SelectionImpact,
  ModelTestResult,
  CodexLoginStatus,
  CodexUsageSnapshot,
  CodexUsageWindow,
  CodexUsageLimit,
  CodexCredits,
  CodexResetCredit,
  CodexResetInput,
  CodexResetOutcome,
} from "../../server/src/contracts";

export class RequestError extends Error {
  get details() { return this.status ? `HTTP ${this.status}` : undefined; }
  constructor(
    message: string,
    public fields: Record<string, string> = {},
    public status?: number,
    public selectionImpact?: ApiError["selectionImpact"],
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      signal,
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RequestError(
      "Cannot reach ufAI. Check the server connection and try again.",
    );
  }
  if (!response.ok) {
    const result = (await response.json().catch(() => null)) as ApiError | null;
    throw new RequestError(
      typeof result?.error === "string" && result.error.trim() ? result.error : requestFailureMessage(response.status),
      result?.fields,
      response.status,
      result?.selectionImpact,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

export function requestFailureMessage(status: number): string {
  if (status === 502 || status === 503 || status === 504)
    return "ufAI is temporarily unavailable. Wait a moment, then try again.";
  if (status === 401 || status === 403)
    return "This action is not available. Check the connection or sign-in settings and try again.";
  if (status === 404) return "This item is no longer available. Refresh the view and try again.";
  if (status === 429) return "Too many requests. Wait a moment, then try again.";
  return "ufAI could not complete this request. Please try again.";
}

export function getPage<T>(path: string, offset: number) {
  return request<Page<T>>(`${path}?limit=100&offset=${offset}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
