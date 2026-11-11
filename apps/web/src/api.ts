import type { ApiError, Page } from "../../server/src/contracts";
export type {
  Workspace,
  ModelPreset,
  PresetInput,
  ProviderId,
  IntegrationKind,
  Compaction,
} from "../../server/src/contracts";

export class RequestError extends Error {
  constructor(
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
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

export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(`ufai.${key}`);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(`ufai.${key}`, value);
  } catch {
    /* Browser preferences are optional. */
  }
}
