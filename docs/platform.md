# ufAI platform guide

## Purpose and current availability

ufAI is an MIT-licensed, local-first application for one user per local backend installation, intended to help that user organize AI agents through a browser dashboard. The intended experience includes multiple workspaces, configurable agents, visual communication connections, skills, instructions, and triggers. The user would connect supported paid APIs, local models, or supported existing agent runtimes.

**Current availability: early functional dashboard.** The browser provides collapsible navigation, persisted workspace tabs, empty flowboards, a shared model preset library, and locked light/dark defaults with custom themes. Settings contains a heading only. Saved API connections, model discovery, and bundled Codex subscription sign-in are available from the preset editor. Agent editing/execution, actual compaction, local-provider setup, and the in-app assistant are not implemented.

The backend and its SQLite database hold one shared setup across browser sessions. Application accounts and multi-user tenancy are outside the product scope. Sign-in concerns external provider/runtime connections, not application accounts.

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
- **Purpose:** Persist workspaces, shared model preset configurations, custom themes, provider connections, application preferences, and workspace viewports locally.
- **Prerequisites:** Server startup and a writable database location.
- **Behavior / steps:** Starting the server creates the database's parent directory and opens or creates `data/ufai.sqlite` relative to the repository root by default. The connection uses WAL mode and enables foreign-key enforcement. Versioned migrations create workspace, model preset, custom theme, singleton application settings, per-workspace viewport, and connection tables. One Default workspace is seeded only on initial migration. Settings initially select Light Mode, a collapsed sidebar, and the first existing workspace, or none if the workspace list is empty. Graceful server shutdown closes the connection.
- **Limitations:** Agent data is not implemented. Database-wide encryption, backup tooling, import/export, and migration downgrade features are not provided. API keys are encrypted separately; keep the credential directory with the database when making a manual backup. Local database files are ignored by Git.
- **Related references:** [Persistence](architecture.md#persistence), [configuration](architecture.md#configuration).

### dashboard-navigation

- **Status:** implemented
- **Purpose:** Navigate the local dashboard using Home, Model Presets, Theme, and Settings.
- **Behavior / steps:** The left sidebar starts as icons and can expand to icons and labels. Hash URLs support direct linking, refresh, and browser back/forward. Sidebar expansion and the selected workspace are saved in SQLite for the entire local setup. Shared settings load before the dashboard opens and refresh when a tab regains focus or becomes visible. Older browser preferences are ignored. Failed preference saves keep the last confirmed setting and offer Retry. URL history and unfinished forms remain temporary.
- **Limitations:** Settings has a heading only. Appearance is configurable through [Themes](#dashboard-themes).
- **Branding:** The sidebar uses the Relay symbol on a transparent background without a border, with the ufAI wordmark when expanded. Clicking the sidebar logo opens the [project's GitHub repository](https://github.com/ufukogutcu/ufAI) in a new tab, keeping the dashboard and unsaved drafts open. The theme preview uses the same transparent symbol. The browser favicon uses a simplified Relay symbol. Both follow the saved theme's logo colors; unsaved theme previews remain confined to the editor.

### dashboard-themes

- **Status:** implemented
- **Purpose:** Choose Light Mode, Dark Mode, or custom application colors.
- **Behavior / steps:** The local setup starts in Light Mode. The selected theme is saved in SQLite and used across browser sessions, independently of browser/system color preferences. Open Theme to inspect locked defaults or use a saved theme. Both defaults are permanent; use Duplicate to customize one. Create theme starts with any loaded theme. Custom themes support names, light/dark native controls, editing, duplication, and confirmed deletion; they persist in this ufAI instance's SQLite database and are shared across workspaces and browsers.
- **Editor:** Search by component or color purpose, expand color groups, and use swatches, hex fields, and opacity sliders. Controls highlight the affected preview area; selecting a preview swatch opens and focuses its color control. Dashboard, navigation, buttons, form, feedback, flowboard, dialog, and decorative examples preview draft colors without recoloring the editor. Contrast suggestions are advisory. Save persists; Use theme applies a saved theme. Saving edits to the currently active theme updates its application colors. Cancel and navigation guard unsaved changes; failed saves retain drafts.
- **Startup / fallback:** Catalog-based Light Mode styles cover startup while shared settings load. The dashboard opens with the server-resolved active theme, including a custom theme beyond the first library page. A startup failure shows Retry. Failed later refreshes retain the last confirmed theme in memory. Deleting the active custom theme selects Light Mode transactionally. New color scopes inherit defaults from each custom theme's native-control mode.
- **Limitations:** Changes in another open session appear on focus, visibility return, or reload; there is no continuous push synchronization, system-following option, or import/export. Theme library lists reload when reopening Theme. Custom-theme edits use the last successful write. Refreshes preserve unsaved editor drafts. Native browser dialogs use the chosen light/dark scheme rather than individually editable browser colors.
- **Related references:** [Theme architecture and color rules](architecture.md#themes), [Theme API](api.md#themes).

### dashboard-tooltips

- **Status:** implemented
- **Purpose:** Show consistent dashboard-styled help for sidebar icons, workspace actions, flowboard controls, and dialog close buttons.
- **Behavior / steps:** Tooltips appear after 400 ms of mouse hover or immediately on keyboard focus. Moving onto the tooltip keeps it visible. Moving away from both the control and tooltip dismisses it after a short delay. Blur, activation, Escape, scrolling, or resizing dismisses it immediately. Escape dismisses a tooltip inside a dialog before closing the dialog itself. Sidebar navigation tooltips appear only when the sidebar is collapsed.
- **Limitations:** Tooltips contain text only. Disabled controls and touch hover do not show tooltips; control labels remain available independently of tooltips.
- **Related references:** [Tooltip component](architecture.md#tooltips).

### workspaces

- **Status:** partial
- **Purpose:** Organize work into named workspaces with separate flowboards.
- **Behavior / steps:** Home shows workspace tabs above the selected workspace’s name and optional goal description. Empty descriptions are hidden; saved line breaks are preserved. Use the plus button to create a workspace, tabs to switch workspaces, and edit/delete controls for the active workspace. Create and Edit workspace dialogs accept a required name and an optional description of up to 4,000 characters. Save persists both fields; Cancel discards changes, and failed saves retain entered values for retry. Deletion requires confirmation. Records and the active selection persist in SQLite. Creating a workspace selects it. Deleting the selected workspace chooses its next neighbor in creation order, then its previous neighbor, or none; deletion also removes its saved viewport. Arrow keys, Home, and End navigate workspace tabs. Additional records load through the load-more control.
- **Limitations:** Workspaces currently contain names, optional descriptions, and empty boards. Existing workspaces start with empty descriptions. Agent configuration, communication permissions, resources, and execution are not implemented. Deleting every workspace shows a create-workspace empty state; restarting does not restore the seed.
- **Related references:** [Flowboards](#agent-canvas), [HTTP API](api.md).

### agent-canvas

- **Status:** partial
- **Purpose:** Provide a visual board for each workspace.
- **Behavior / steps:** Drag to pan, scroll to zoom, or use zoom and reset-view buttons. Each workspace restores its own saved viewport from SQLite. Completed pan/zoom interactions persist, including zoom/reset buttons; pointer movement does not write continuously. Viewports refresh when returning to a tab, and failed loads or saves offer Retry.
- **Limitations:** Viewports survive reload and server restart. A failed save retains the current view in memory for retry; it is not durable until confirmed. There are no agent nodes, editing tools, communication connections, permissions, or execution behavior yet.

### model-presets

- **Status:** partial
- **Purpose:** Save reusable model configurations shared across every workspace.
- **Behavior / steps:** Open Model Presets to create or edit a shared preset. Enter its name first, choose API or Subscription, then a provider. API choices include OpenAI, Anthropic, Google Gemini, OpenRouter, xAI, DeepSeek, Mistral, Groq, Together, and Custom OpenAI-compatible. Subscription offers Codex. Use Connect/Manage to save a connection in a dialog, then search the fetched models or enter a model ID manually. Context window and maximum output are optional and editable; selecting a different model uses its reported limits when available. Save writes the preset to SQLite. Cancel/navigation guard unsaved preset changes; deletion requires confirmation. Failed saves retain the draft.
- **Connections:** The first saved connection is the default for new presets using that provider. Connection options reveals additional accounts/endpoints and an unlinked/manual choice. Manage supports renaming, replacing an API key, default selection, and confirmed deletion. Connection saves are independent of preset saves: cancelling a preset does not remove a saved connection. Changing the default does not rebind saved presets; deleting a connection preserves linked presets and unlinks them.
- **Compaction:** Defaults to 80% of context, with an optional absolute token threshold. Percentage thresholds round down with a minimum of one token; unknown context displays Unknown. Changing to token mode uses the current effective threshold if known, otherwise requires manual entry. Changing back to percentage resets to 80%. Known context bounds output and absolute compaction limits.
- **Compatibility:** Existing presets remain editable and initially unlinked. Legacy Ollama/custom integrations are retained in the editor for existing records but not offered for new presets. Notes have been removed, including their saved database column. A model absent from discovery can remain saved as a manual ID.
- **Limitations:** Discovery needs network access and a valid connection where the provider requires authentication. A model list is not a guarantee of inference access. Unsupported endpoints, expired credentials, empty lists, and timeouts offer retry/manual entry. Metadata not reported by the provider stays unknown. No agent assignment, inference, runtime execution, or compaction execution is implemented. Preset edits use the last successful write; cross-tab preset synchronization is not implemented.
- **Related references:** [Connections](#provider-connections), [Codex sign-in](#runtime-connections), [API contracts](api.md#model-presets).

### provider-connections

- **Status:** partial
- **Purpose:** Save reusable API accounts/endpoints and discover model options for presets.
- **Behavior / steps:** In a preset, select an API provider and use Connect. Enter a connection name and API key; custom compatible endpoints also require an API base URL and may omit the key. Additional connections are available under Connection options. Saved metadata refreshes when opening Model Presets and returning to a tab, without replacing editor drafts.
- **Storage:** Keys stay on the backend, encrypted with a local key file. Responses report credential availability without returning credentials. Browser storage is not used. Local files and a usable credential key must remain together for connections to survive moving/restoring the installation.
- **Limitations:** Supports model-list discovery, not inference execution. Custom endpoints implement the OpenAI model-list format; HTTPS is required except for loopback HTTP. Dedicated local integrations and arbitrary provider authentication schemes remain planned. Saved credentials are shared by this single-user backend, not isolated per browser.
- **Related references:** [Connection API](api.md#provider-connections), [Storage and runtime boundaries](architecture.md#provider-connections-and-discovery).

### runtime-connections

- **Status:** partial
- **Purpose:** Sign in to Codex with ChatGPT and discover subscription model choices.
- **Prerequisites:** Install ufAI dependencies with optional dependencies enabled on a supported Codex platform. A separate/global Codex CLI install is not needed. Internet access and an account eligible for Codex are required for sign-in/model access.
- **Behavior / steps:** Choose Subscription → Codex → Connect. Use Sign in with ChatGPT, then Continue to ChatGPT to complete the browser flow and return to ufAI. The dialog reports completion. Use a device code when the browser callback is unavailable. Manage offers reconnect, cancel pending sign-in, and sign-out. Each connection has its own ufAI-owned runtime credential directory; existing personal Codex installations are not reused or changed.
- **Limitations:** Only authentication and model discovery are integrated. Model availability depends on the signed-in account; no agent execution or guaranteed entitlement is implied. Closing the connection dialog cancels a pending login. Sign-out clears that connection's runtime login. Deleting a connection deletes its local runtime credential directory and unlinks presets.
- **Related references:** [Connection API](api.md#provider-connections), [Codex lifecycle](architecture.md#provider-connections-and-discovery).

## Setup and troubleshooting

- **Port occupied:** Identify the existing process before acting; do not stop unrelated applications. Choose another server port with `PORT` or development UI port with `WEB_PORT`. For example, `WEB_PORT=5174 npm run dev` changes the UI port on a POSIX shell. Open the selected port rather than the default URL.
- **UI unavailable after server startup:** Ensure `npm run build` completed and open the correct port. The server registers static UI serving only when the frontend build directory exists at startup; rebuild and restart if it was absent. Development UI uses Vite's port.
- **Recent source changes are absent:** Rebuild and restart the production process, or use development mode.
- **Database cannot open:** Check the configured path and directory permissions. Do not delete an existing database to troubleshoot without explicit authorization and an appropriate recovery plan.
- **Invalid server port:** `PORT` must be an integer from 1 through 65535.
- **Configuration seems ignored:** Set variables in the launching shell/process. Environment-file loading is not configured.

These are repository-defined behaviors, not a claim that a particular process is currently running. Consult [configuration](architecture.md#configuration) for defaults and path resolution.

## Planned capabilities

All entries below are **planned**; partial connection capabilities are described above. Configuration choices in the dashboard do not implement these integrations or execution capabilities. Shared prerequisites are intentionally unspecified until implementation establishes them.

| Capability ID | Status | Purpose / intended behavior | Limitations | Related references |
| --------------------- | ------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `agent-configuration` | planned | Give each agent instructions, skills, permissions, memory, and its own working space | No agent model or execution exists; directories alone would not provide security isolation | [Extension boundaries](architecture.md#extension-boundaries) |
| `agent-messaging` | planned | Let permitted agents send messages or tasks to one another | No message transport, inbox, delivery/retry behavior, or conversation routing exists | [Extension boundaries](architecture.md#extension-boundaries) |
| `agent-triggers` | planned | Start agent work from schedules, events, webhooks, and custom triggers | No trigger engine or background job queue exists; timing, recovery, and overlap policies remain future design work | [Extension boundaries](architecture.md#extension-boundaries) |
| `platform-assistant` | planned | Help users understand ufAI and configure their workspaces through an in-app assistant | No assistant, tools, documentation retrieval, or automatic workspace setup exists | [Documentation reading paths](README.md#reading-paths) |

This table records product direction, not an implementation schedule. Do not present a planned capability as available or invent setup instructions for it.
