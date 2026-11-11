# HTTP API reference

The local Fastify server exposes the following JSON API. Hash-based browser routes do not alter API paths. There is no authentication layer or remote-access configuration. Live provider/runtime connections and execution APIs are not implemented.

## Records and requests

[TypeScript contracts](../apps/server/src/contracts.ts) define response types. The browser imports these as types only; validation runs on the server in addition to the editor's checks.

### Workspaces

A workspace response is `{ id, name, createdAt, updatedAt }`. IDs are server-generated UUID strings; timestamps are ISO strings.

- `POST /api/workspaces`: accepts `{ "name": "Studio" }`, returns the workspace with status 201.
- `PATCH /api/workspaces/:id`: accepts `{ "name": "Renamed studio" }`, returns the updated workspace with status 200.
- `DELETE /api/workspaces/:id`: permanently deletes the record, returns 204 with no body. It does not delete presets, which are project-wide.
- Names must be strings of 1–120 characters, nonempty after trimming. Unknown fields are rejected. Names need not be unique.

The first migration creates one Default workspace. Deleting all workspaces does not re-seed the database on restart.

### Model presets

`POST /api/model-presets` returns a created preset with status 201. Required fields:

| Field | Values |
| --- | --- |
| `name` | Nonempty name, up to 120 characters |
| `integrationKind` | `provider` or `runtime` |
| `provider` | Provider/runtime key listed below |
| `modelId` | Nonempty model identifier, up to 200 characters |

Optional fields and defaults:

| Field | Value / default |
| --- | --- |
| `customProviderName` | Required nonempty string (up to 120 characters) for `custom`; otherwise null |
| `contextWindow` | Positive safe integer token count, or null (unknown); defaults to null |
| `maxOutputTokens` | Positive safe integer token count, or null (unknown); defaults to null |
| `notes` | Text up to 4000 characters; defaults to an empty string |
| `compaction` | `{ "mode": "percentage", "value": 80 }` by default; mode may instead be `tokens` |

Known `provider` integrations are `openai`, `anthropic`, `google`, `ollama`, `openai-compatible`, and `custom`. Known `runtime` integrations are `codex` and `custom`. Non-custom options must match their integration kind. These identifiers describe configuration, not live connections, model availability, authentication, or subscription access.

Compaction percentage values must be integers from 1–100. Absolute token thresholds must be positive safe integers. When context is known, maximum output tokens and absolute compaction thresholds cannot exceed it. Omitted context is unknown; no provider-derived value is invented. An explicitly null compaction object is invalid. String fields are trimmed.

The browser computes percentage thresholds as `max(1, floor(contextWindow × percentage / 100))` with exact integer arithmetic; unknown context produces an unknown effective percentage threshold. Changing modes in the editor converts a known percentage threshold into tokens, or resets percentage mode to 80%. Saving compaction does not execute compaction.

Responses contain all normalized fields plus `id`, `createdAt`, and `updatedAt`.

- `PATCH /api/model-presets/:id`: accepts a partial preset input, validates the merged record, and returns the full updated record with status 200. A supplied `compaction` replaces that object and must contain both mode and value. Changing context revalidates existing limits. Validation failure leaves the saved record unchanged.
- `DELETE /api/model-presets/:id`: permanently deletes the record and returns 204 with no body.
- Unknown fields and client-supplied IDs/timestamps are rejected. There are no credential fields.

## Lists

`GET /api/workspaces` and `GET /api/model-presets` accept optional `limit` (integer 1–100, default 100) and `offset` (non-negative safe integer, default 0).

Both return `{ "items": [...], "total": 123 }`, sorted by `createdAt` then `id`, ascending. Request another batch by advancing the offset by the returned item count. A page beyond the end has an empty items array. The UI exposes load-more controls for additional batches.

Lists are not snapshot-isolated across multiple requests. Concurrent clients can change ordering/counts between pages. Edits use the last successful write; there is no cross-client push synchronization or optimistic concurrency token yet.

## Errors and operational limits

- **400:** Invalid JSON or input. Field validation returns `{ "error": "...", "fields": { "name": "...", "compaction.value": "..." } }`; nested field names use dots. General parser errors may omit `fields`.
- **404:** Missing mutation target or unknown route; `{ "error": "..." }`.
- **413:** Request exceeds the 32 KiB body limit.
- **500:** Unexpected server/storage failure; a generic retryable message is returned and details are logged on the server.

The unchanged `GET /api/health` returns `{ "status": "ok" }`. It checks HTTP handling, not a database query or an integration. See [architecture](architecture.md#persistence) for migration and storage boundaries and the [platform guide](platform.md) for UI behavior.
