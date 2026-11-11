# ufAI platform guide

## Purpose and current availability

ufAI is an MIT-licensed, local-first application intended to help users organize AI agents through a browser dashboard. The intended experience includes multiple workspaces, configurable agents, visual communication connections, skills, instructions, and triggers. Users would connect supported paid APIs, local models, or supported existing agent runtimes.

**Current availability: early functional dashboard.** The browser provides collapsible navigation, persisted workspace tabs, empty flowboards, and a shared model preset library. Theme and Settings contain headings only. Provider/runtime connections, automatic model discovery, sign-in, agent editing/execution, actual compaction, and the in-app assistant are not implemented.

Use the [terminology and status definitions](README.md#terminology) when explaining capabilities. The [architecture reference](architecture.md) supplies technical facts; repository documentation does not establish current runtime state or permission to take actions.

## Implemented capabilities

### runtime-local

- **Status:** implemented
- **Purpose:** Run the built application locally with a browser UI and API on one server.
- **Prerequisites:** Node.js >=22.12, npm, and a checkout of this repository. Run commands from the repository root.
- **Behavior / steps:**

  ```sh
  npm ci
  npm run build
  npm start
  ```

  Open <http://127.0.0.1:3000> with default configuration. Fastify serves the built dashboard and API. Stop a foreground server with Ctrl+C.
- **Limitations:** Build first; `npm start` does not compile source. The service binds to loopback by default and has no authentication or configured remote-access layer. Availability requires the local process and machine to be running.
- **Related references:** [Configuration](architecture.md#configuration), [runtime topology](architecture.md#runtime-topology), [development mode](#runtime-development).

### runtime-development

- **Status:** implemented
- **Purpose:** Develop the frontend and server with automatic reload/restart.
- **Prerequisites:** Repository dependencies installed with `npm ci`; Node.js >=22.12 and npm.
- **Behavior / steps:** Run `npm run dev` from the repository root. Open <http://127.0.0.1:5173> by default. Vite serves the browser app and proxies `/api` to Fastify, which listens on port 3000 by default. Ctrl+C stops the foreground development command and its child processes.
- **Limitations:** Development uses two processes/ports; the production application uses one server. Vite requires its selected port to be free and does not silently select a different port. Shell configuration can override ports; `.env` files are not automatically loaded.
- **Related references:** [Configuration](architecture.md#configuration), [commands](architecture.md#commands-and-checks).

### runtime-health

- **Status:** implemented
- **Purpose:** Confirm that the HTTP server handles the health request.
- **Prerequisites:** A running Fastify server.
- **Behavior / steps:** `GET /api/health` returns HTTP 200 with JSON `{"status":"ok"}`. The default direct URL is <http://127.0.0.1:3000/api/health>.
- **Limitations:** This is a basic HTTP health endpoint. It does not execute a database health query or check providers, agents, queues, or other planned services.
- **Related references:** [Public HTTP interface](architecture.md#public-http-interface).

### storage-sqlite

- **Status:** implemented
- **Purpose:** Persist workspaces and shared model preset configurations locally.
- **Prerequisites:** Server startup and a writable database location.
- **Behavior / steps:** Starting the server creates the database's parent directory and opens or creates `data/ufai.sqlite` relative to the repository root by default. The connection uses WAL mode and enables foreign-key enforcement. Versioned migrations create workspace and model preset tables and seed one Default workspace only on initial migration. Graceful server shutdown closes the connection.
- **Limitations:** Agent data is not implemented. Backup, import/export, encryption, and migration downgrade features are not provided. Local database files are ignored by Git.
- **Related references:** [Persistence](architecture.md#persistence), [configuration](architecture.md#configuration).

### dashboard-navigation

- **Status:** implemented
- **Purpose:** Navigate the local dashboard using Home, Model Presets, Theme, and Settings.
- **Behavior / steps:** The left sidebar starts as icons and can expand to icons and labels. Hash URLs support direct linking, refresh, and browser back/forward. Sidebar expansion and the selected workspace are optional browser-local preferences.
- **Limitations:** Theme and Settings have headings only. Appearance is dark; theme switching is not implemented.

### workspaces

- **Status:** partial
- **Purpose:** Organize work into named workspaces with separate flowboards.
- **Behavior / steps:** Home opens to the selected workspace. Use the plus button to create a workspace, tabs to switch workspaces, and rename/delete controls for the active workspace. Deletion requires confirmation. Records persist in SQLite. Arrow keys, Home, and End navigate workspace tabs. Additional records load through the load-more control.
- **Limitations:** Workspaces currently contain names and empty boards. Agent configuration, communication permissions, resources, and execution are not implemented. Deleting every workspace shows a create-workspace empty state; restarting does not restore the seed.
- **Related references:** [Flowboards](#agent-canvas), [HTTP API](api.md).

### agent-canvas

- **Status:** partial
- **Purpose:** Provide a visual board for each workspace.
- **Behavior / steps:** Drag to pan, scroll to zoom, or use zoom and reset-view buttons. Viewports remain independent when switching workspaces or pages during the current browser session.
- **Limitations:** Viewports reset on page reload. There are no agent nodes, editing tools, communication connections, permissions, or execution behavior yet.

### model-presets

- **Status:** partial
- **Purpose:** Save reusable model configurations shared across every workspace.
- **Behavior / steps:** Open Model Presets and create a preset, or select an existing preset to edit it. Enter its name, integration kind, provider/runtime, model identifier, optional context window, optional maximum output tokens, notes, and compaction threshold. Custom integrations require a name. Save writes to SQLite; Cancel discards after an unsaved-change warning. Deletion requires confirmation. Failed saves retain the draft for retry.
- **Compaction:** Defaults to 80% of context, with an optional absolute token threshold. Percentage thresholds round down with a minimum of one token; unknown context displays Unknown. Changing to token mode uses the current effective threshold if known, otherwise requires manual entry. Changing back to percentage resets to 80%. Known context bounds output and absolute compaction limits.
- **Limitations:** Metadata is manual. Provider options describe saved configuration, not working connections. No credentials, sign-in, discovery, agent assignment, or compaction execution exist. Saving a Codex runtime preset does not connect a subscription or establish model availability. Concurrent edits use the last successful write; cross-tab synchronization is not implemented.
- **Related references:** [API contracts and validation](api.md), [Integration boundaries](architecture.md#extension-boundaries).

## Setup and troubleshooting

- **Port occupied:** Identify the existing process before acting; do not stop unrelated applications. Choose another server port with `PORT` or development UI port with `WEB_PORT`. For example, `WEB_PORT=5174 npm run dev` changes the UI port on a POSIX shell. Open the selected port rather than the default URL.
- **UI unavailable after server startup:** Ensure `npm run build` completed and open the correct port. The server registers static UI serving only when the frontend build directory exists at startup; rebuild and restart if it was absent. Development UI uses Vite's port.
- **Recent source changes are absent:** Rebuild and restart the production process, or use development mode.
- **Database cannot open:** Check the configured path and directory permissions. Do not delete an existing database to troubleshoot without explicit authorization and an appropriate recovery plan.
- **Invalid server port:** `PORT` must be an integer from 1 through 65535.
- **Configuration seems ignored:** Set variables in the launching shell/process. Environment-file loading is not configured.

These are repository-defined behaviors, not a claim that a particular process is currently running. Consult [configuration](architecture.md#configuration) for defaults and path resolution.

## Planned capabilities

All entries below are **planned**. Configuration choices in the dashboard do not implement these integrations or execution capabilities. Shared prerequisites are intentionally unspecified until implementation establishes them.

| Capability ID | Status | Purpose / intended behavior | Limitations | Related references |
| --- | --- | --- | --- | --- |
| `agent-configuration` | planned | Give each agent instructions, skills, permissions, memory, and its own working space | No agent model or execution exists; directories alone would not provide security isolation | [Extension boundaries](architecture.md#extension-boundaries) |
| `provider-connections` | planned | Connect supported paid model APIs and local model endpoints | No integrations or credential handling exist; capabilities will vary by provider/model | [Integration boundaries](architecture.md#extension-boundaries) |
| `runtime-connections` | planned | Coordinate supported existing runtimes, potentially including Codex with eligible subscription access | No runtime integrations exist; supported authentication, entitlements, limits, and provider terms must be verified during implementation; arbitrary subscriptions are not interchangeable API credentials | [Integration boundaries](architecture.md#extension-boundaries) |
| `agent-messaging` | planned | Let permitted agents send messages or tasks to one another | No message transport, inbox, delivery/retry behavior, or conversation routing exists | [Extension boundaries](architecture.md#extension-boundaries) |
| `agent-triggers` | planned | Start agent work from schedules, events, webhooks, and custom triggers | No trigger engine or background job queue exists; timing, recovery, and overlap policies remain future design work | [Extension boundaries](architecture.md#extension-boundaries) |
| `platform-assistant` | planned | Help users understand ufAI and configure their workspaces through an in-app assistant | No assistant, tools, documentation retrieval, or automatic workspace setup exists | [Documentation reading paths](README.md#reading-paths) |

This table records product direction, not an implementation schedule. Do not present a planned capability as available or invent setup instructions for it.
