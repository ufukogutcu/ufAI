# ufAI architecture reference

## Current implementation

ufAI is an npm-workspace repository containing a React + Vite browser app and a Node.js + Fastify server, all in TypeScript. SQLite is opened through `better-sqlite3`. The project is MIT licensed.

The application provides static UI serving, a health route, workspace, model preset and custom theme CRUD, versioned SQLite persistence, and a React dashboard with empty flowboards. See the [platform capability inventory](platform.md) for current availability and product direction. Local `AGENTS.md` files may provide additional working instructions and are ignored by Git.

## Repository map

| Location | Responsibility |
| --- | --- |
| [Root package manifest](../package.json) | Workspace membership, shared development tools, root commands, and Node requirement |
| [Server entry point](../apps/server/src/index.ts) | Process configuration, application creation, listening, and shutdown |
| [Database initialization](../apps/server/src/database.ts) | Database path resolution, connection, pragmas, and versioned migrations |
| [Browser application](../apps/web/src/App.tsx) | Dashboard shell, hash navigation, sidebar and page composition |
| [API application](../apps/server/src/app.ts) | Testable Fastify application with workspace and preset routes |
| [API contracts](../apps/server/src/contracts.ts) | API record types; the browser imports these types without loading server code |
| [Browser entry point](../apps/web/src/main.tsx) | React root, Strict Mode, and global SCSS and React Flow stylesheet imports |
| [Vite configuration](../apps/web/vite.config.ts) | React plugin, development host/port, and `/api` proxy |
| [CI workflow](../.github/workflows/ci.yml) | Locked dependency installation, type checking, tests, and building |
| `data/` | Generated local SQLite data; ignored by Git |

Workspace manifests and the lockfile define installed dependencies and versions. Zustand, Sass, React Flow (`@xyflow/react`), and Lucide are installed. React Compiler is not configured. Component styles use SCSS modules with a small global foundation. No ORM is installed.

## Runtime topology

**Production:** Browser requests reach one persistent Fastify process. `npm run build` compiles the server into `apps/server/dist` and the UI into `apps/web/dist`. `npm start` runs the compiled server. At startup, the server registers `@fastify/static` only if the UI build directory exists. The root URL serves the built page; `/api/health` is handled by Fastify.

**Development:** The root command runs Fastify through `tsx watch` and the Vite server through `concurrently`. Vite serves frontend source and proxies `/api` requests to the configured Fastify host/port. The Vite browser listener is fixed to loopback; `HOST` configures Fastify and the development proxy target, not Vite's bind address. The development command is configured to terminate the other child command when one exits.

No reverse proxy, container runtime, external database server, worker service, provider process, or message broker is configured. Client navigation uses hash routes (`#/home`, `#/model-presets`, `#/theme`, `#/settings`) without a router dependency or SPA fallback. Arbitrary server paths do not return the application.

## Startup and shutdown

1. Read `HOST` and `PORT`; reject non-integer ports or values outside 1–65535.
2. Create Fastify with logging enabled and open the SQLite connection. Database initialization and versioned migrations are synchronous and must succeed before HTTP listening. Unsupported newer schema versions fail startup without downgrading the database.
3. Register the close hook, health and application routes, and static assets when present.
4. Listen on the configured address. Listening errors are logged, trigger shutdown, and set a failing process exit code.
5. On `SIGINT` or `SIGTERM`, close Fastify; its close hook closes SQLite. Shutdown errors are logged and set a failing exit code.

Database-open failures occur during startup before the listener is available. This is not a supervisor: process installation, automatic restart, and background-service management are not implemented.

## Configuration

Variables are read from the launching process environment. There is no application-level automatic `.env` loading.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Fastify bind address and Vite API proxy target host |
| `PORT` | `3000` | Fastify port and Vite API proxy target port; integer 1–65535 |
| `WEB_PORT` | `5173` | Vite development port; `strictPort` causes startup failure if occupied |
| `DATABASE_PATH` | Repository-root `data/ufai.sqlite` | SQLite file path; relative overrides resolve from the server process's current working directory |

The default database path is resolved relative to the server module, so it points to repository-root `data/ufai.sqlite` in both source and compiled layouts. Root commands and workspace commands can have different working directories; prefer an absolute database override when that distinction matters.

All documented commands assume execution from the repository root. Loopback defaults do not provide authentication. Binding to another interface does not establish secure remote access; no authentication or remote-access layer is configured.

## Public HTTP interface

| Method / path | Response or behavior | Limitations |
| --- | --- | --- |
| `GET /api/health` | HTTP 200, JSON `{"status":"ok"}` | Does not run a database query or check planned services |
| `GET /` | Built dashboard HTML when static serving was registered at startup | Requires frontend build output |
| `GET/POST /api/workspaces` | Paginated list / create workspace | Names and IDs only; no agent contents |
| `PATCH/DELETE /api/workspaces/:id` | Rename / permanently delete workspace | Missing IDs return 404 |
| `GET/POST /api/model-presets` | Paginated list / create shared preset | Configuration only |
| `PATCH/DELETE /api/model-presets/:id` | Partially update / permanently delete preset | Missing IDs return 404 |
| `GET/POST /api/themes` | Paginated built-in/custom library / create custom theme | Built-ins always precede custom records |
| `GET/PATCH/DELETE /api/themes/:id` | Read / edit / delete theme | Built-in edits and deletion return 403 |
| Static asset paths from the built HTML | Assets served by `@fastify/static` | No custom client-side routing fallback |

See the [HTTP API reference](api.md) for payloads, validation, defaults, errors, and pagination. There are no agent, live provider/runtime connection, messaging, trigger, approval, or assistant endpoints. No SSE/WebSocket application interface exists. API contracts remain type-only; the data-only `@ufai/theme-catalog` workspace package shares color metadata and palettes without server runtime imports.

## Persistence

- `openDatabase()` creates the parent directory recursively and opens or creates one SQLite file.
- It enables `journal_mode = WAL` and `foreign_keys = ON`. WAL may create companion files beside the database.
- The database connection is owned by the server process and closed by the Fastify close hook.
- Schema versioning uses SQLite `user_version`. Migration 1 creates `workspaces` and `model_presets`, adds creation-order indexes, seeds one Default workspace, and advances the version in one short transaction. It also upgrades the original empty scaffold database.
- Migration 2 adds `themes` and its creation-order index without changing existing workspace/preset records. Custom themes store name, light/dark mode, JSON colors, and timestamps. Built-ins come from the shared catalog rather than mutable database rows.
- Records use server-generated UUIDs and ISO timestamps. Presets store compaction mode/value separately. Prepared statements use parameter binding; list queries are paginated at at most 100 rows per request. Names need not be unique.
- Seeding runs only during migration, including when every workspace is later deleted. Migrations are forward-only; databases newer than this application are rejected.
- The Fastify application owns its database handle. Tests construct isolated applications with temporary database paths or in-memory SQLite. Workspace deletion currently has no associated agent data to cascade.
- `data/` is ignored by Git. A database path outside that directory is not automatically ignored; do not stage local data or credentials.
- Backups, encryption, migration downgrades, and data import/export are not implemented.

## Decisions and rationale

| Decision | Rationale / boundary |
| --- | --- |
| TypeScript across browser and server | Shared language and tooling; strict compiler settings are configured |
| React + Vite | Interactive browser UI with a separate development/build tool |
| One persistent Fastify application server | One production server and port; room for future local orchestration without a required second application service |
| SQLite via `better-sqlite3` | Local persistence without a separate database service; synchronous operations must stay bounded |
| npm workspaces | Coordinate browser and server packages in one repository |
| MIT | Permissive open-source licensing; dependencies and provider terms retain their own conditions |
| Zustand and SCSS modules | Provider-scoped shared state with narrow selectors; local editor drafts and component-scoped styling |
| React Flow viewport | Empty pan/zoom canvas with independent session-only viewports; no agent graph yet |
| Type-only API contracts | Share record shapes without bundling server modules or creating a runtime package |

## Client state

The current UI has an application-scoped Zustand store, created once by its provider. It caches server records and holds selection plus per-workspace viewport state. Page lists load in 100-record batches; immutable updates preserve unchanged record references. Form drafts stay in local React state. Server responses establish saved state; API failures do not replace drafts. SQLite stores durable records, browser local storage holds optional navigation preferences, and canvas viewports exist only in memory. Pointer and zoom events do not write to SQLite. Unsaved preset and theme changes guard page changes, record selection, cancellation, and browser unload.

## Themes

The data-only [theme catalog](../packages/theme-catalog/catalog.json) is the single source of semantic keys, CSS variables, editor metadata, preview regions, and complete light/dark palettes. It has no build step or runtime dependencies. Application SCSS and TSX consume registered variables; the source/canonical-palette checks run through the browser workspace's Node tests. Each new color scope needs a stable key/CSS variable, complete light/dark values, a label and description, component usage, an editor group, and a representative preview example. Application-authored colors must use semantic catalog tokens; structural `transparent`, `inherit`, and `currentColor` are allowed.

Built-in `light-mode` and `dark-mode` records are assembled from the catalog, never stored as editable rows. The API blocks their PATCH/DELETE operations. Custom-theme colors resolve against the selected base mode on reads and writes, filling newly added keys while retaining existing values. Theme contracts stay in the server's type-only contracts module. Hex values are validated on the server and normalized to six/eight digits; arbitrary CSS expressions are not accepted.

An independent provider-scoped Zustand theme store holds saved library records and the active browser selection. Narrow selectors keep color-picker drafts out of shared state. A local editor draft scopes custom properties to its preview, and selection maps catalog regions to preview examples. Successful saves establish saved state; editing an active theme applies its new saved palette. Only successful deletion can trigger active-theme fallback. The shared unsaved-change guard covers both preset and theme editors.

Vite injects system-aware fallback CSS from the catalog into the HTML head for early paint. Before mounting React, startup validates `ufai.theme` in optional local storage, resolves its colors, and applies the remembered theme. Cached built-in colors are replaced with catalog values to preserve immutability. The provider persists the initial choice once and subscribes to saved selection changes; there is no system-preference listener. A cached custom theme is refreshed by ID, including one beyond the first library page. A 404 selects the current system-matched default; other failures retain the validated cache. An in-flight refresh cannot replace a later selection or saved edit. The cache is optional and not authoritative storage for custom themes.

Lists load at most 100 records per request, with immutable defaults first, then custom records by creation order. No push synchronization or optimistic concurrency token is provided. Palette changes do not remount React Flow or reset workspace viewports; its color mode and dot grid follow the active theme. Browser-native controls receive the theme's light/dark `color-scheme`.

## Tooltips

The shared [Tooltip component](../apps/web/src/components/Tooltip.tsx) accepts text `content`, an optional `placement` (`top`, `right`, `bottom`, or `left`; defaults to `top`), and one native HTML element as its child. It clones that element without a layout wrapper, preserves existing handlers and refs, and appends its stable tooltip ID to `aria-describedby` while visible. Keep the control's accessible name independent of the tooltip; use this component instead of native `title` attributes for UI help. Empty content and disabled children suppress tooltips.

Tooltip state and timers are component-local. Mouse hover opens after 400 ms; keyboard focus opens immediately. A 120 ms closing delay allows the pointer to cross onto the tooltip. Activation, blur, Escape, scrolling, and resizing dismiss it; Escape and activation suppress reopening until the pointer leaves or focus is lost. Timers, open-state listeners, and resize observers are cleaned up. No animation is used, including with reduced motion enabled.

SCSS modules style the text bubble using dashboard color variables. A fixed-position portal targets the nearest open dialog, or the document body outside dialogs, to avoid canvas transforms and keep modal help above the backdrop. Positioning flips to the opposite side when it offers more room and clamps to an 8 px viewport margin. Sidebar tooltips prefer the right; toolbar tooltips prefer the top. Tooltips are hoverable text, contain no focusable controls, and never become keyboard tab stops. No tooltip library, server interface, or persisted state is required.

## Extension boundaries

The following execution and integration boundaries remain future direction:

- **Model providers versus agent runtimes:** Provider adapters would supply inference to a ufAI-owned agent loop. Runtime adapters would coordinate existing agent loops and sessions. Preserve this distinction rather than pretending all integrations expose the same API or authentication.
- **Orchestration versus display:** Keep workspace/agent state, permission checks, message routing, jobs, and run lifecycle on the application side. Canvas layout is presentation; links must ultimately be enforced by the server. Communication permissions and execution dependencies are separate concepts.
- **Execution versus isolation:** Per-agent directories and runtime configuration organize working spaces. Strong isolation requires a suitable execution boundary; a directory or child process alone is not a security sandbox.
- **Persistence versus temporary UI state:** Keep durable records behind a persistence boundary and shared reactive UI state in appropriately scoped Zustand stores. Avoid cross-workspace state leakage and unnecessary subscriptions.
- **Triggers:** Future sources of work should enter a common job/run path. Delivery, recovery after downtime, retries, idempotency, time zones, overlap, and resource limits must be designed and documented when implemented; none is currently provided.
- **Platform assistance:** The platform guide is potential assistant knowledge. Retrieval, packaging, safe tool interfaces, permissions, and live-state lookup would require explicit implementation; Markdown documentation alone enables none of them.

## Commands and checks

| Command | Current behavior |
| --- | --- |
| `npm ci` | Install locked dependencies |
| `npm run dev` | Launch server watch mode and Vite development mode |
| `npm run typecheck` | Run TypeScript checks for both workspaces |
| `npm test` | Run Node test-runner checks through tsx in both workspaces |
| `npm run build` | Compile server; type-check and build browser assets |
| `npm start` | Start compiled server; does not build or watch source |

Node.js >=22.12 and npm are required; `.nvmrc` selects Node 22. CI uses that file, then runs `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. Tests cover API/database behavior, client-store isolation and server-confirmed updates, theme API/migrations/cache/catalog rules, and form calculations/validation; no automated browser suite or lint command is configured. Development Strict Mode is enabled in the browser entry point; distinguish development checks from production performance measurements.

For documentation maintenance, follow the [index checklist](README.md#maintenance-checklist) rather than treating a successful build as documentation validation.
