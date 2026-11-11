import type { ApiError, Page } from "../../server/src/contracts";
export type {
  Workspace,
  ModelPreset,
  PresetInput,
  ProviderId,
  IntegrationKind,
  Compaction,
  ProviderConnection,
  ConnectionInput,
  ConnectionProvider,
  DiscoveredModel,
  CodexLoginStatus,
} from "../../server/src/contracts";

export class RequestError extends Error {
  constructor(
    message: string,
    public fields: Record<string, string> = {},
    public status?: number,
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
      result?.error ?? `Request failed (${response.status}). Please try again.`,
      result?.fields,
      response.status,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

export function getPage<T>(path: string, offset: number) {
  return request<Page<T>>(`${path}?limit=100&offset=${offset}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
