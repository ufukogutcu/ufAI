# HTTP API reference

The local Fastify server exposes the following JSON API for one user and one shared setup. Hash-based browser routes do not alter API paths. There is no authentication layer or remote-access configuration. Live provider/runtime connections and execution APIs are not implemented.

## Records and requests

[TypeScript contracts](../apps/server/src/contracts.ts) define response types. The browser imports these as types only; validation runs on the server in addition to the editor's checks.

### Workspaces

A workspace response is `{ id, name, createdAt, updatedAt }`. IDs are server-generated UUID strings; timestamps are ISO strings.

- `POST /api/workspaces`: accepts `{ "name": "Studio" }`, returns the workspace with status 201 and transactionally makes it the active workspace.
- `PATCH /api/workspaces/:id`: accepts `{ "name": "Renamed studio" }`, returns the updated workspace with status 200.
- `DELETE /api/workspaces/:id`: permanently deletes the record, returns 204 with no body. It also deletes the saved viewport. If selected, the next workspace in creation order becomes active, then the previous workspace if no next one exists, or null if none remain. These changes are transactional. It does not delete presets, which are installation-wide.
- Names must be strings of 1–120 characters, nonempty after trimming. Unknown fields are rejected. Names need not be unique.

The first migration creates one Default workspace. Deleting all workspaces does not re-seed the database on restart.

### Application settings

- `GET /api/settings` returns `{ settings: { activeThemeId, activeWorkspaceId, sidebarExpanded }, activeTheme, activeWorkspace }`. The resolved records use the existing theme/workspace response types; `activeWorkspaceId` and `activeWorkspace` may be null. Resolution does not depend on list pagination.
- `PATCH /api/settings` accepts any subset of `activeThemeId` (existing built-in/custom theme ID), `activeWorkspaceId` (existing workspace ID or null), and `sidebarExpanded` (boolean). It returns the same full response with status 200. Only supplied fields change; unknown fields, invalid types, and missing referenced records return 400 with field errors, leaving settings unchanged. An empty patch is a no-op.
- Settings are one singleton per installation, without browser or user identifiers. Initial defaults are `light-mode`, `false` for sidebar expansion, and the first existing workspace by `createdAt`, then `id`, or null. Existing browser preferences are ignored.
- Startup loads settings before showing the dashboard. Open tabs refresh on focus/visibility return; there is no continuous push synchronization. Successful writes establish saved preferences.

### Workspace viewports

- `GET /api/workspaces/:id/viewport` returns `{ x, y, zoom }`, defaulting to `{ x: 0, y: 0, zoom: 1 }` until saved.
- `PATCH /api/workspaces/:id/viewport` accepts any subset of those three fields, merges into the saved/default viewport, and returns the full viewport with status 200. Coordinates must be finite numbers; zoom must be a finite number from 0.25 through 2. Unknown fields or invalid values return 400 without changing saved state. An empty patch is a no-op in value.
- Both routes return 404 for a missing workspace. Each workspace has one viewport shared by all sessions; deleting it cascades viewport deletion. The browser saves completed interactions rather than pointer events, coalescing pending writes to the latest completed view.

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

### Themes

`GET /api/themes` returns a paginated `{ items, total }` library. The first two records are immutable `light-mode` (Light Mode) and `dark-mode` (Dark Mode), followed by custom themes sorted by `createdAt`, then `id`. Pagination uses the same bounds as other lists, and offsets include built-ins. `GET /api/themes/:id` reads a theme directly, including one outside the current list page.

A theme is `{ id, name, mode, colors, builtIn, createdAt, updatedAt }`. `mode` is `light` or `dark` for native controls and newly added color defaults. `colors` maps stable keys from the [shared catalog](../packages/theme-catalog/catalog.json) to hex colors. Responses include every current key. Built-ins have null timestamps; custom records have server-generated UUIDs and ISO timestamps.

- `POST /api/themes`: accepts `{ name, mode, colors }`, returns a custom theme with status 201. A color object is required; `{}` starts from the selected mode's defaults. Names are trimmed, nonempty, at most 120 characters, and need not be unique. Duplication posts an independent copy of a saved theme's name/mode/colors with a new name.
- `PATCH /api/themes/:id`: accepts partial name/mode/colors and returns the saved full record with status 200. Supplied color keys merge into existing values. Missing/new keys resolve from the base mode. Changing mode preserves existing explicit colors. Validation failures leave the saved record unchanged.
- `DELETE /api/themes/:id`: permanently removes a custom theme and returns 204. If active, selection switches to `light-mode` in the same transaction. Built-ins never disappear.
- Hex values accept `#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA` and normalize to lowercase six/eight-digit values. Unknown color keys, arbitrary CSS values, invalid input types, and protected/unknown fields (including `id`, `builtIn`, and timestamps) are rejected with 400 and field errors.
- PATCH/DELETE of either built-in returns **403** with an explanatory error, regardless of request body. Missing IDs return 404. Active selection belongs to the singleton application settings.

## Lists

`GET /api/workspaces` and `GET /api/model-presets` accept optional `limit` (integer 1–100, default 100) and `offset` (non-negative safe integer, default 0).

Workspace and preset lists return `{ "items": [...], "total": 123 }`, sorted by `createdAt` then `id`, ascending. Request another batch by advancing the offset by the returned item count. A page beyond the end has an empty items array. The UI exposes load-more controls for additional batches.

Lists are not snapshot-isolated across multiple requests. Concurrent clients can change ordering/counts between pages. Edits use the last successful write; there is no cross-client push synchronization or optimistic concurrency token yet.

## Errors and operational limits

- **400:** Invalid JSON or input. Field validation returns `{ "error": "...", "fields": { "name": "...", "compaction.value": "..." } }`; nested field names use dots. General parser errors may omit `fields`.
- **403:** Attempt to edit or delete a built-in theme; `{ "error": "..." }`.
- **404:** Missing record/mutation target or unknown route; `{ "error": "..." }`.
- **413:** Request exceeds the 32 KiB body limit.
- **500:** Unexpected server/storage failure; a generic retryable message is returned and details are logged on the server.

The unchanged `GET /api/health` returns `{ "status": "ok" }`. It checks HTTP handling, not a database query or an integration. See [architecture](architecture.md#persistence) for migration and storage boundaries and the [platform guide](platform.md) for UI behavior.
