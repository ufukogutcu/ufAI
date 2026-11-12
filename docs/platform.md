# ufAI platform guide

## Purpose and current availability

ufAI is a local-first application for one user to organize AI agents and related work across multiple workspaces in a browser. Its intended experience includes configurable agents, communication permissions, reusable skills, instructions, and triggers.

**Current availability: early functional dashboard.** Users can manage workspaces and empty flowboards, save model presets and provider connections, discover model choices, sign in to Codex with ChatGPT, and customize themes. Settings currently contains a heading only. Agent editing/execution, inference, actual compaction, dedicated local-model integrations, messaging, triggers, and the built-in assistant are not available.

One local installation holds one shared setup across browser sessions. There are no ufAI application accounts or separate profiles for each browser. Sign-in connects an external provider/runtime account; it does not create a ufAI account. See the [terminology and feature-status guide](README.md) when explaining these distinctions.

## Available capabilities

### runtime-local

- **Status:** implemented
- **Purpose:** Use ufAI locally through a browser.
- **Behavior:** The local application must be running before the browser can open it. The usual address is <http://127.0.0.1:3000>, but an installation may use a different address.
- **Limitations:** The local process and machine must remain available. A page that cannot connect does not establish that saved data has been lost. Remote access and application-account sign-in are not provided.

### saved-data

- **Status:** implemented
- **Purpose:** Keep saved workspaces, model presets, provider connections, custom themes, and application preferences on this local installation.
- **Behavior:** Saved records survive closing the browser and restarting ufAI. The selected workspace, active theme, and completed canvas pan/zoom positions are shared across browser sessions. Unsaved forms, open dialogs, and navigation history are temporary.
- **Limitations:** Saving and viewing data requires the local application to be reachable. There is no built-in backup, import, or export tool. Connection credentials and the rest of the saved installation data must be kept together when making a manual backup. Deleting saved records requires confirmation and has no in-app undo.

### dashboard-navigation

- **Status:** implemented
- **Purpose:** Reach Home, Model Presets, Theme, and Settings.
- **Behavior:** Use the page icons on the left. Hover or keyboard focus shows their labels. Pages support direct links, refresh, and browser back/forward. The logo opens ufAI's [GitHub project](https://github.com/ufukogutcu/ufAI) in a new tab, keeping the current page and drafts open.
- **Limitations:** Settings contains a heading only. Use [Theme](#dashboard-themes) for appearance changes. If a preference cannot be saved, the last confirmed setting remains in use and Retry is available.

### dashboard-themes

- **Status:** implemented
- **Purpose:** Choose Light Mode, Dark Mode, or custom application colors.
- **Steps:** Open Theme to see the gallery. Use a saved theme to apply it, or inspect a built-in theme to see its colors. Light Mode and Dark Mode are permanent and locked; choose Duplicate to customize a copy. Create theme can start from an existing theme.
- **Editing:** Give the theme a name, choose light/dark native controls, and search for a color or component. Groups contain color swatches, hex fields, and opacity sliders. The preview shows draft colors without changing the app. Selecting a preview swatch reveals its color control. The preview is collapsible on narrow screens. Back to library returns to the gallery; unfinished changes prompt before being discarded.
- **Saving and applying:** Save stores the theme. Use theme applies a saved theme. Saving changes to an already active theme updates the app's appearance. Cancel discards the draft; a failed save retains it. Deleting an active custom theme selects Light Mode.
- **Limitations:** The app initially uses Light Mode and remembers the saved choice independently of the device's appearance preference. There is no automatic system-following mode or theme import/export. Changes from another browser session appear on returning to the tab or reloading, without replacing unsaved drafts. Native browser dialogs follow the chosen light/dark mode rather than individually edited colors. After an application update, restarting ufAI may be necessary before saving newly available color options.

### dashboard-tooltips

- **Status:** implemented
- **Purpose:** Explain icons and other compact controls.
- **Behavior:** Hover or focus a control to see its label or help. Escape dismisses a tooltip; inside a dialog, the first Escape dismisses the tooltip before another Escape closes the dialog.
- **Limitations:** Disabled controls and touch hover do not show tooltips. Keyboard labels remain available independently.

### workspaces

- **Status:** partial
- **Purpose:** Organize related work into separate named spaces.
- **Steps:** On Home, use the plus button to create a workspace and its tab to select it. Create and Edit workspace accept a required name and an optional description of up to 4,000 characters. The selected workspace's description appears beneath its name when provided. Edit and delete controls apply to the active workspace.
- **Saving and switching:** Save stores both fields; Cancel discards edits, and failed saves retain entered values for retry. Creating a workspace selects it. Arrow keys, Home, and End navigate tabs. Additional workspaces load through the load-more control.
- **Deletion:** Confirmation is required. Deleting the selected workspace selects the next neighboring workspace, then the previous one if needed. Deleting every workspace leaves an empty state; restarting ufAI does not recreate the deleted workspace.
- **Limitations:** Workspaces currently contain names, descriptions, and empty [flowboards](#agent-canvas). Agent configuration, communication permissions, resources, and execution are not available.

### agent-canvas

- **Status:** partial
- **Purpose:** Provide a visual board for each workspace.
- **Steps:** Drag to pan, scroll to zoom, or use the zoom and reset-view buttons. Each workspace remembers its own completed view changes across reloads and restarts.
- **Limitations:** The board has no agent nodes, editing tools, communication connections, or execution yet. Failed view loads or saves offer Retry. An unsaved view may remain visible during a save failure, but it is not durable until the save succeeds.

### model-presets

- **Status:** partial
- **Purpose:** Save reusable model configurations shared across workspaces.
- **Steps:** Open Model Presets, create a preset, and enter its name. Choose API or Subscription, then a provider. API options include OpenAI, Anthropic, Google Gemini, OpenRouter, xAI, DeepSeek, Mistral, Groq, Together, and Custom OpenAI-compatible. Subscription offers Codex.
- **Choosing a model:** Use Connect or Manage to save a connection, then search its available models or enter a model ID manually. Context window and maximum output are optional and editable. Selecting another model uses its reported limits when available; missing information stays Unknown.
- **Connections:** The first saved connection is the default for new presets using that provider. Connection options shows additional accounts/endpoints and an unlinked/manual choice. Changing the default does not rebind saved presets. Deleting a connection unlinks its presets without deleting them. A saved connection remains saved even if the preset form is later cancelled.
- **Compaction configuration:** The default threshold is 80% of context. An absolute token threshold is also available. Percentage thresholds round down, with a minimum of one token; unknown context displays Unknown. Switching to token mode uses the known effective threshold or requires manual entry. Switching back to percentage resets to 80%. Known context limits constrain output and absolute thresholds.
- **Saving:** Save stores the preset; Cancel and navigation protect unsaved edits. Deletion requires confirmation. A failed save retains the draft. Older presets remain editable, including legacy choices no longer offered for new presets. A model missing from discovery can remain saved as a manual ID.
- **Limitations:** A discovered model is not a guarantee that the account can use it. A preset is configuration only: no inference, agent assignment, execution, or compaction is performed. Preset changes from another session are not continuously synchronized, and the last successful save wins.
- **Related:** [API connections](#provider-connections), [Codex sign-in](#runtime-connections).

### provider-connections

- **Status:** partial
- **Purpose:** Save provider accounts/endpoints and discover model choices for presets.
- **Steps:** Select an API provider in a preset and choose Connect. Enter a connection name and API key. A custom compatible endpoint also needs its base URL and may not require a key. Connection options exposes additional connections. Manage supports renaming, replacing a key, choosing the default, and confirmed deletion.
- **Privacy:** Credentials are stored locally. Saved API keys are encrypted and are not returned to the browser. These connections belong to the shared local installation, not an individual browser profile.
- **Limitations:** Connections currently support model discovery, not inference. Discovery needs network access and valid credentials where required. Unsupported endpoints, expired credentials, empty model lists, and timeouts can prevent discovery; retry or enter a model ID manually. Custom compatible endpoints require HTTPS except for local loopback addresses. Dedicated local integrations and other authentication methods remain planned.

### runtime-connections

- **Status:** partial
- **Purpose:** Sign in to Codex with ChatGPT and discover subscription model choices.
- **Prerequisites:** Internet access and an account eligible for Codex are required. Codex support is bundled with ufAI; no separate global Codex installation is needed.
- **Steps:** Choose Subscription → Codex → Connect. Select Sign in with ChatGPT, then Continue to ChatGPT, finish the browser flow, and return to ufAI. Use the device-code option when the normal browser callback is unavailable. Manage offers reconnect, cancellation of pending sign-in, and sign-out.
- **Behavior:** Each saved Codex connection has its own sign-in. Existing personal Codex installations are not reused or changed. Closing the connection dialog cancels a pending login. Sign-out clears that connection's login; deleting it also unlinks its presets.
- **Limitations:** Only sign-in and model discovery are available. Model availability depends on the account; signing in does not guarantee access to every model or enable agent execution in ufAI.

## Common questions

- **Why is the board empty?** Agent editing and execution are not available yet. Creating a workspace or preset does not create or run an agent.
- **Why does compaction do nothing?** Its threshold is saved configuration only; compaction execution is not available.
- **Why won't ufAI open?** Check that the local installation is running and that the browser is using its configured address. The documentation cannot establish the current state of the user's machine.
- **Why are models missing?** Check the selected connection and sign-in, retry discovery, or use a manual model ID. Discovery results and account access can differ.
- **Why did my theme or workspace change in another browser?** All sessions share the same local setup. There are no separate per-browser accounts or preference profiles.
- **What should I do after a save fails?** Keep the draft open and use Retry or save again when the local installation is reachable. Do not treat a failed save as confirmed or delete saved data to resolve it.
- **Can I export or automatically back up my setup?** No built-in export or backup tool is provided. Preserve all saved installation data and connection credentials together when making a manual backup.

## Planned capabilities

These capabilities are not available yet. This is product direction, not a release schedule.

| Capability ID | Status | Intended purpose | Current limitation |
| --- | --- | --- | --- |
| `agent-configuration` | planned | Configure agents with instructions, skills, permissions, and a model/runtime | Agent creation and execution are unavailable |
| `agent-messaging` | planned | Let permitted agents communicate | Messaging and communication permissions are unavailable |
| `agent-triggers` | planned | Start work manually, on a schedule, or from events | Agent runs, scheduling, and triggers are unavailable |
| `platform-assistant` | planned | Help users understand ufAI and configure their workspaces | No built-in assistant or automatic use of these documents is connected yet |
