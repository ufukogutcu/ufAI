# ufAI architecture reference

## Current implementation

ufAI is an npm-workspace repository containing a React + Vite browser app and a Node.js + Fastify server, all in TypeScript. SQLite is opened through `better-sqlite3`. The project is MIT licensed.

The application provides static UI serving, a health route, workspace, model preset and custom theme CRUD, versioned SQLite persistence, and a React dashboard with empty flowboards, saved provider connections, model discovery, and bundled Codex sign-in. See the [platform capability inventory](platform.md) for current availability and product direction. Local `AGENTS.md` files may provide additional working instructions and are ignored by Git.

## Repository map

| Location | Responsibility |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
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

## Single-user setup and working rules

One local backend installation and its SQLite database represent one user's setup across all browser sessions. Application accounts, multi-user tenancy, and browser-specific preference profiles are outside the product scope; future authentication concerns external provider/runtime connections. Durable preferences and workspace presentation state belong in backend persistence. URL history, unsaved forms, dialogs, and pointer/focus state remain temporary. Do not introduce browser identities or use browser storage as preference authority.

## Runtime topology

**Production:** Browser requests reach one persistent Fastify process. `npm run build` compiles the server into `apps/server/dist` and the UI into `apps/web/dist`. `npm start` runs the compiled server. At startup, the server registers `@fastify/static` only if the UI build directory exists. The root URL serves the built page; `/api/health` is handled by Fastify.

**Development:** The root command runs Fastify through `tsx watch` and the Vite server through `concurrently`. Vite serves frontend source and proxies `/api` requests to the configured Fastify host/port. The Vite browser listener is fixed to loopback; `HOST` configures Fastify and the development proxy target, not Vite's bind address. The development command is configured to terminate the other child command when one exits.

No reverse proxy, container runtime, external database server, worker service, or message broker is configured. Codex app-server child processes start lazily for subscription sign-in and model discovery. Client navigation uses hash routes (`#/home`, `#/model-presets`, `#/theme`, `#/settings`) without a router dependency or SPA fallback. Arbitrary server paths do not return the application.

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
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `HOST` | `127.0.0.1` | Fastify bind address and Vite API proxy target host |
| `PORT` | `3000` | Fastify port and Vite API proxy target port; integer 1–65535 |
| `WEB_PORT` | `5173` | Vite development port; `strictPort` causes startup failure if occupied |
| `DATABASE_PATH` | Repository-root `data/ufai.sqlite` | SQLite file path; relative overrides resolve from the server process's current working directory |

The default database path is resolved relative to the server module, so it points to repository-root `data/ufai.sqlite` in both source and compiled layouts. Root commands and workspace commands can have different working directories; prefer an absolute database override when that distinction matters.

All documented commands assume execution from the repository root. Loopback defaults do not provide authentication. Binding to another interface does not establish secure remote access; no authentication or remote-access layer is configured.

## Public HTTP interface

| Method / path | Response or behavior | Limitations |
| -------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `GET /api/health` | HTTP 200, JSON `{"status":"ok"}` | Does not run a database query or check planned services |
| `GET /` | Built dashboard HTML when static serving was registered at startup | Requires frontend build output |
| `GET/POST /api/workspaces` | Paginated list / create workspace | Names and optional goal descriptions; no agent contents |
| `PATCH/DELETE /api/workspaces/:id` | Edit name/description / permanently delete workspace | Missing IDs return 404 |
| `GET/PATCH /api/settings` | Shared settings and resolved active theme/workspace | One settings record per installation |
| `GET/PATCH /api/workspaces/:id/viewport` | Saved pan/zoom, defaulting to x=0, y=0, zoom=1 | Existing workspace; zoom 0.25–2 |
| `GET/POST /api/model-presets` | Paginated list / create shared preset | Configuration only |
| `PATCH/DELETE /api/model-presets/:id` | Partially update / permanently delete preset | Missing IDs return 404 |
| `/api/connections` and per-connection routes | Saved credentials, metadata, model lists, and Codex sign-in        | See [Connection API](api.md#provider-connections); local-origin access |
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
- Migration 3 adds singleton `app_settings` and `workspace_viewports` keyed by workspace ID, preserving all previous records. Defaults are Light Mode, a collapsed sidebar, and the first existing workspace by creation order, or null. Old browser preferences are ignored. Workspace foreign keys clear deleted selections and cascade viewport deletion. API transactions select newly created workspaces, repair active workspace selection to its next/previous neighbor on deletion, and select Light Mode when deleting the active custom theme.
- Migration 4 adds a non-null workspace description with an empty-string default, preserving existing records, settings, timestamps, and viewports. Workspace creation accepts an optional description; partial edits preserve omitted fields and empty patches leave timestamps unchanged.
- Migration 5 creates `connections` with one default per provider, adds nullable preset connection references with `ON DELETE SET NULL`, and drops preset notes. Existing preset IDs, timestamps, provider/model settings, workspaces, themes, preferences, and viewports are retained. A removed default selects the oldest remaining connection; deleting any connection never rebinds presets.
- Records use server-generated UUIDs and ISO timestamps. Presets store compaction mode/value separately. Prepared statements use parameter binding; list queries are paginated at at most 100 rows per request. Names need not be unique.
- Seeding runs only during migration, including when every workspace is later deleted. Migrations are forward-only; databases newer than this application are rejected.
- The Fastify application owns its database handle. Tests construct isolated applications with temporary database paths or in-memory SQLite. Workspace deletion currently has no associated agent data to cascade.
- `data/` is ignored by Git. A database path outside that directory is not automatically ignored; do not stage local data or credentials.
- Database-wide encryption, backup tooling, migration downgrades, and data import/export are not implemented. API credential encryption and native Codex storage are described below.

## Decisions and rationale

| Decision | Rationale / boundary |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| TypeScript across browser and server | Shared language and tooling; strict compiler settings are configured |
| React + Vite | Interactive browser UI with a separate development/build tool |
| One persistent Fastify application server | One production server and port; room for future local orchestration without a required second application service |
| SQLite via `better-sqlite3` | Local persistence without a separate database service; synchronous operations must stay bounded |
| npm workspaces | Coordinate browser and server packages in one repository |
| MIT | Permissive open-source licensing; dependencies and provider terms retain their own conditions |
| Zustand and SCSS modules | Provider-scoped shared state with narrow selectors; local editor drafts and component-scoped styling |
| React Flow viewport | Empty pan/zoom canvas with independent SQLite-backed viewports; no agent graph yet |
| Type-only API contracts | Share record shapes without bundling server modules or creating a runtime package |

## Client state

Provider-scoped Zustand stores cache server records through narrow selectors. A shared settings store holds the server-confirmed settings snapshot plus resolved active theme/workspace. Startup requests settings before mounting the dashboard; failure leaves a retryable startup screen. Active records resolve independently of list pagination. Page lists load in 100-record batches; immutable updates preserve unrelated references. Home places workspace tabs above a header displaying the server-resolved selected workspace’s name and optional plain-text description. The pencil dialog edits both fields; descriptions retain line breaks and the header scrolls for long content to keep the flowboard accessible. Form drafts stay in local React state, and settings refreshes do not replace editor records/drafts or remount the application.

Settings refresh on window focus or visible-tab return; paired events share one refresh, and listeners are cleaned up. Local settings-affecting writes are serialized in action order. Revision checks reject stale reads after newer actions; refresh skips pending writes. A completed CRUD request remains successful if its subsequent settings refresh fails, avoiding duplicate creates on retry. Preference failures retain confirmed values and expose the failed patch for retry. Later read failures retain the in-memory snapshot and expose a read retry. There is no browser preference storage or continuous synchronization service.

Each workspace viewport loads before first canvas display. React Flow owns motion, while move-start invalidates stale reads and move-end supplies a completed viewport for persistence. Writes keep at most one in-flight request and one latest pending viewport per workspace. Remote viewport application does not trigger another persistence write. Refresh skips active interactions and writes. Read failures retry reads; save failures retain the current view and retry saves. Deleting a workspace clears its cached viewport and associated request bookkeeping. URL history, dialogs, and unfinished interactions remain temporary. Unsaved preset and theme changes guard page changes, record selection, cancellation, and browser unload.

## Themes

The data-only [theme catalog](../packages/theme-catalog/catalog.json) is the single source of semantic keys, CSS variables, editor metadata, preview regions, and complete light/dark palettes. It has no build step or runtime dependencies. Application SCSS and TSX consume registered variables; the source/canonical-palette checks run through the browser workspace's Node tests. Each new color scope needs a stable key/CSS variable, complete light/dark values, a label and description, component usage, an editor group, and a representative preview example. Application-authored colors must use semantic catalog tokens; structural `transparent`, `inherit`, and `currentColor` are allowed.

Built-in `light-mode` and `dark-mode` records are assembled from the catalog, never stored as editable rows. The API blocks their PATCH/DELETE operations. Custom-theme colors resolve against the selected base mode on reads and writes, filling newly added keys while retaining existing values. Theme contracts stay in the server's type-only contracts module. Hex values are validated on the server and normalized to six/eight digits; arbitrary CSS expressions are not accepted.

An independent provider-scoped Zustand theme store holds saved library records; the shared settings snapshot owns active selection. Narrow selectors keep color-picker drafts out of shared state. A local editor draft scopes custom properties to its preview, and selection maps catalog regions to preview examples. Successful saves establish saved state; editing an active theme applies its new saved palette. Only successful deletion can trigger active-theme fallback. The shared unsaved-change guard covers both preset and theme editors.

Vite injects Light Mode fallback CSS from the catalog into the HTML head for early paint. Startup loads `/api/settings` and applies its resolved active theme before displaying the dashboard. Neither browser storage nor browser/system color preferences determine selection. A settings subscription applies confirmed palette changes to the root. Active theme saves refresh the resolved palette, while successful deletion selects Light Mode in the same server transaction. Refresh failures retain the last confirmed in-memory palette; there is no persisted browser theme cache.

Relay branding uses inline SVG on transparent, borderless wrappers in the sidebar and theme preview, with font-independent wordmark paths. The sidebar brand is a native external link to the project GitHub repository with `target="_blank"` and `rel="noopener noreferrer"`; it does not use the internal hash-navigation handler. Symbol geometry is shared through [branding.ts](../apps/web/src/branding.ts). The `logo-text` and `logo-secondary` color keys and palette values are retained for custom-theme compatibility. Retired logo tile gradient and border scopes are ignored when resolving older custom themes; remaining saved overrides are preserved. Vite injects a simplified SVG data-URL favicon with catalog Light Mode colors; the theme provider updates it from the confirmed active theme's `logo-text` and `logo-secondary` colors. Separate favicon SVG documents cannot inherit the application's CSS variables. Unsaved preview drafts update neither the root theme nor the favicon.

Lists load at most 100 records per request, with immutable defaults first, then custom records by creation order. No push synchronization or optimistic concurrency token is provided. Palette changes do not remount React Flow or reset workspace viewports; its color mode and dot grid follow the active theme. Browser-native controls receive the theme's light/dark `color-scheme`.

## Tooltips

The shared [Tooltip component](../apps/web/src/components/Tooltip.tsx) accepts text `content`, an optional `placement` (`top`, `right`, `bottom`, or `left`; defaults to `top`), and one native HTML element as its child. It clones that element without a layout wrapper, preserves existing handlers and refs, and appends its stable tooltip ID to `aria-describedby` while visible. Keep the control's accessible name independent of the tooltip; use this component instead of native `title` attributes for UI help. Empty content and disabled children suppress tooltips.

Tooltip state and timers are component-local. Mouse hover opens after 400 ms; keyboard focus opens immediately. A 120 ms closing delay allows the pointer to cross onto the tooltip. Activation, blur, Escape, scrolling, and resizing dismiss it; Escape and activation suppress reopening until the pointer leaves or focus is lost. Timers, open-state listeners, and resize observers are cleaned up. No animation is used, including with reduced motion enabled.

SCSS modules style the text bubble using dashboard color variables. A fixed-position portal targets the nearest open dialog, or the document body outside dialogs, to avoid canvas transforms and keep modal help above the backdrop. Positioning flips to the opposite side when it offers more room and clamps to an 8 px viewport margin. Sidebar tooltips prefer the right; toolbar tooltips prefer the top. Tooltips are hoverable text, contain no focusable controls, and never become keyboard tab stops. No tooltip library, server interface, or persisted state is required.

## Provider connections and discovery

The [connection service](../apps/server/src/connections.ts) owns connection metadata, credential validation, defaults, and preset/provider matching. [Model-provider adapters](../apps/server/src/model-providers.ts) handle HTTP model catalogs separately from the [Codex runtime adapter](../apps/server/src/codex-runtime.ts). Neither implements inference or agent execution. Preset imports into the browser remain type-only.

API credentials use AES-256-GCM with the connection ID as authenticated data. The server lazily creates a 32-byte key at `<absolute database filename>.connections/connections.key`; the credential directory is owner-only and the key has mode 0600 on POSIX. This protects the database contents independently of the key; it does not protect against access to both files or the running server. Restore/move the database together with its credential directory. In-memory test databases use an ephemeral key and temporary runtime directories. Credential writes are explicit dialog actions, never picker events. API keys/tokens are omitted from responses and upstream error bodies/stderr are not logged. Requests to connection routes validate the local host, browser Origin when present, and Fetch Metadata; no cross-origin access or application accounts are introduced. Keep local binding; these checks are not remote-user authentication.

Custom OpenAI-compatible base URLs must use HTTPS, except loopback HTTP, and cannot contain user info, query strings, or fragments. Changing a keyed custom endpoint requires re-entering the key. Named providers use fixed official endpoints. Requests reject redirects, use the provider's header-based authentication, and share one 10-second deadline across reads and pages. Discovery permits at most four simultaneous connections, coalesces identical requests, and bounds catalogs to ten pages, 5,000 normalized models, and 4 MiB total response bytes. Errors are sanitized and remain compatible with manual model IDs. Metadata comes only from reported provider fields; explicit unsupported capabilities/types are filtered. There is no persistent model catalog or static model-ID fallback.

Codex is an exact pinned npm dependency, including its platform binary; the launcher resolves it from ufAI dependencies and never searches global PATH. It runs app-server over stdio with ufAI client metadata, ChatGPT-only authentication, and runtime-managed file credentials. Each connection uses `<credential directory>/codex/<connection UUID>` as its isolated `CODEX_HOME` and working directory; inherited Codex/OpenAI environment overrides are removed. The parent drains stderr without recording it. Only initialization, account/login lifecycle, account status, and model-list protocol methods are used. Browser OAuth is hosted by the native runtime; ufAI returns its validated HTTPS sign-in URL and polls completion while the dialog is open. Device-code login is an alternative. Runtime OAuth tokens are stored by Codex inside the restricted directory, not in the API credential ciphertext column. Treat this directory as credentials, including when backing up.

There are at most three live runtime clients, sixteen pending RPCs per client, a 15-second RPC/model discovery deadline, and a 1 MiB incoming protocol-buffer bound. Idle clients stop after 60 seconds; pending login may last up to ten minutes. Cancellation, process exits, protocol failures, deletion, and Fastify shutdown settle pending requests and clean up streams/timers/processes. Termination escalates after two seconds, and shutdown waits for child exit before closing storage. Per-connection directories prevent account sharing but are not an execution sandbox. No thread/turn execution methods are exposed.

The preset page owns an isolated Zustand connection store with narrow subscriptions. Refreshes coalesce, preserve newer confirmed mutations, and retain unchanged connection identities. Preset/connection drafts, model searches, dialog state, and discovery responses stay component-local. The model loader aborts obsolete browser requests and ignores late completions. Refreshing catalogs does not select models or rewrite context overrides. Default connections apply on an explicit provider selection for new configurations, not to existing unlinked presets. Connection dialogs save independently and guard their own unsaved input; the preset retains its existing navigation/unload guard.

## Extension boundaries

Execution, orchestration, and integrations beyond connection/model discovery remain future direction:

- **Model providers versus agent runtimes:** Provider adapters would supply inference to a ufAI-owned agent loop. Runtime adapters would coordinate existing agent loops and sessions. Preserve this distinction rather than pretending all integrations expose the same API or authentication.
- **Orchestration versus display:** Keep workspace/agent state, permission checks, message routing, jobs, and run lifecycle on the application side. Canvas layout is presentation; links must ultimately be enforced by the server. Communication permissions and execution dependencies are separate concepts.
- **Execution versus isolation:** Per-agent directories and runtime configuration organize working spaces. Strong isolation requires a suitable execution boundary; a directory or child process alone is not a security sandbox.
- **Persistence versus temporary UI state:** Keep durable records behind a persistence boundary and shared reactive UI state in appropriately scoped Zustand stores. Avoid cross-workspace state leakage and unnecessary subscriptions.
- **Triggers:** Future sources of work should enter a common job/run path. Delivery, recovery after downtime, retries, idempotency, time zones, overlap, and resource limits must be designed and documented when implemented; none is currently provided.
- **Platform assistance:** The platform guide is potential assistant knowledge. Retrieval, packaging, safe tool interfaces, permissions, and live-state lookup would require explicit implementation; Markdown documentation alone enables none of them.

## Commands and checks

| Command | Current behavior |
| ------------------- | ---------------------------------------------------------- |
| `npm ci` | Install locked dependencies |
| `npm run dev` | Launch server watch mode and Vite development mode |
| `npm run typecheck` | Run TypeScript checks for both workspaces |
| `npm test` | Run Node test-runner checks through tsx in both workspaces |
| `npm run build` | Compile server; type-check and build browser assets |
| `npm start` | Start compiled server; does not build or watch source |

Node.js >=22.12 and npm are required; `.nvmrc` selects Node 22. CI uses that file, then runs `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. Tests cover API/database behavior, client-store isolation and server-confirmed updates, theme API/migrations/settings/catalog rules, form calculations/validation, saved connection APIs/credential storage, provider discovery, and Codex lifecycle with mocked processes; no automated browser suite or lint command is configured. Development Strict Mode is enabled in the browser entry point; distinguish development checks from production performance measurements.

For documentation maintenance, follow the [index checklist](README.md#maintenance-checklist) rather than treating a successful build as documentation validation.
