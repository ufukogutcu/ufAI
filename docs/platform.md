# ufAI platform guide

## Purpose and current availability

ufAI is a local-first application for one user to organize AI agents and related work across multiple workspaces in a browser. Its intended experience includes configurable agents, communication permissions, reusable skills, instructions, and triggers.

**Current availability: early functional dashboard.** Users can manage workspaces and empty flowboards, save Agent Presets and Providers, discover and test models, connect local Ollama servers, sign in to Codex with ChatGPT, and customize themes. Settings currently contains a heading only. Agent editing/execution, general inference, actual compaction, messaging, triggers, and the built-in assistant are not available. Model testing sends a short prompt only.

One local installation holds one shared setup across browser sessions. There are no ufAI application accounts or separate profiles for each browser. Sign-in connects an external provider/runtime account; it does not create a ufAI account. See the [terminology and feature-status guide](README.md) when explaining these distinctions.

## Available capabilities

### runtime-local

- **Status:** implemented
- **Purpose:** Use ufAI locally through a browser.
- **Behavior:** The local application must be running before the browser can open it. The usual address is <http://127.0.0.1:3000>, but an installation may use a different address.
- **Limitations:** The local process and machine must remain available. A page that cannot connect does not establish that saved data has been lost. Remote access and application-account sign-in are not provided.

### saved-data

- **Status:** implemented
- **Purpose:** Keep saved workspaces, Agent Presets, Providers, custom themes, and application preferences on this local installation.
- **Behavior:** Saved records survive closing the browser and restarting ufAI. The selected workspace, active theme, and completed canvas pan/zoom positions are shared across browser sessions. Unsaved forms, open dialogs, and navigation history are temporary.
- **Limitations:** Saving and viewing data requires the local application to be reachable. There is no built-in backup, import, or export tool. Connection credentials and the rest of the saved installation data must be kept together when making a manual backup. Deleting saved records requires confirmation and has no in-app undo.

### dashboard-navigation

- **Status:** implemented
- **Purpose:** Reach Home, Providers, Agent Presets, Theme, and Settings.
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
- **Behavior:** Hover or focus a control to see its label or help. Left page-menu labels appear after 100 ms of hover; other tooltips wait 400 ms. Keyboard focus shows tooltips immediately. Escape dismisses a tooltip; inside a dialog, the first Escape dismisses the tooltip before another Escape closes the dialog.
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
- **Purpose:** Save reusable Agent Presets shared across workspaces. The capability ID remains `model-presets`.
- **Steps:** Open Agent Presets. When the library is empty, the new preset form opens automatically; otherwise choose New preset. Enter a name. Optionally select a saved Provider, one of its saved models, and a compaction threshold. Provider setup and model editing belong on [Providers](#provider-connections).
- **Model limits:** The selected model's current context window and maximum output are shown read-only. Edit those shared values in Providers; every preset using that Provider/model sees the changes.
- **Compaction:** Leave the threshold empty for no configuration, or enter a percentage from 1–100 or a positive whole token count. Percentage thresholds round down with a minimum of one token; unknown context displays Unknown. Changing the threshold unit clears its value. A threshold exceeding known context shows a warning and can still be saved.
- **Saving:** Only the name is required. Save stores the preset; failed saves retain the draft. Cancel and navigation protect unsaved edits. Deletion requires confirmation. Deleting its Provider clears Provider/model selections; removing its model clears only the model selection. Names and compaction are preserved.
- **Upgrade behavior:** Previously linked presets keep their Provider/model choices. Older unlinked presets retain their names and compaction, with Provider/model fields cleared. Conflicting historical model limits are shown for review in Providers.
- **Limitations:** Presets do not create, run, or trigger agents, and do not execute compaction. Incomplete presets are permitted; future agent execution will need to validate them. Changes from other sessions refresh on returning to the page; unsaved drafts remain protected.

### provider-connections

- **Status:** implemented
- **Purpose:** Set up named Provider configurations, maintain their model lists, and test model replies.
- **Steps:** Open Providers. When the library is empty, the creation form opens automatically; otherwise choose New Provider. Enter a name and select OpenAI, Anthropic, Google Gemini, OpenRouter, xAI, DeepSeek, Mistral, Groq, Together, Custom OpenAI-compatible, Ollama, or Codex. Multiple named configurations of the same type are supported. Choose the Provider explicitly in each Agent Preset; there is no default or automatic fallback configuration.
- **Connection setup:** Named API services require an API key. Custom OpenAI-compatible servers require their API base URL and may use a key. Ollama normally uses `http://localhost:11434`, accepts another server URL, and does not normally require a key. Use Connect & load models to apply connection settings and try discovery. For [Codex](#runtime-connections), sign in with ChatGPT.
- **Saving:** A saved Provider needs at least one model, discovered or manually added. Discovery and testing do not have to succeed. Unfinished setup is excluded from Agent Preset choices. Cancelling a new setup discards its setup credentials; interrupted setups may appear as Finish setup in the library.
- **Models:** Refresh models tries discovery again and merges newly available models. Existing entries, manually added IDs, and explicit limit overrides are retained. Models omitted from a refresh remain listed with an indication. Search and page controls help browse long lists. Add model accepts an exact model ID without checking upstream availability.
- **Limits:** Edit a model to see automatic context/output limits and optionally override them. Blank overrides use automatic values, which remain Unknown when unavailable. Reset limits to automatic clears overrides when saved. Model changes save independently of the connection form. Refresh does not erase overrides.
- **Testing:** Test sends “Reply with OK.” through the selected model. A nonempty completed assistant reply confirms that it answered; the exact wording can differ. The latest result shows its time, duration, and a short reply or error. Tests may consume provider usage. Tests have a two-minute deadline and can be cancelled; replacing credentials or endpoints clears previous results. A successful test does not measure the configured context capacity or guarantee future access.
- **Privacy:** Credentials stay on the local backend. Saved API keys are encrypted and never returned to the browser. Provider records belong to the shared local installation. Deleting a Provider removes its local model records and credentials; it does not revoke an upstream API key.
- **Limitations:** Discovery requires a reachable service and credentials where applicable. A model appearing in a catalog is not proof of account access. Discovery failures leave the previous saved list intact. Custom and Ollama endpoints require HTTPS except for loopback HTTP. Provider setup and prompt tests do not enable general agent execution.

### runtime-connections

- **Status:** partial
- **Purpose:** Connect Codex using a ChatGPT subscription for model discovery and short model tests.
- **Steps:** Create a Codex configuration on Providers and choose Sign in with ChatGPT. Follow Continue to ChatGPT and return after sign-in. A device code is an alternative. After sign-in, ufAI tries to load models. Reconnect, cancel sign-in, or sign out from the same page.
- **Behavior:** Codex is bundled with ufAI; a separate global CLI installation is not required. Model testing creates a temporary conversation solely for the short prompt. Signing out clears prior model-test results but keeps model configurations and preset bindings.
- **Limitations:** Account entitlement and the bundled runtime determine availability. A subscription does not imply access to the separate OpenAI API. General Codex tasks, agent runs, and persistent conversations are not provided.

## Common questions

- **Why is the board empty?** Agent editing and execution are not available yet. Creating a workspace or preset does not create or run an agent.
- **Why does compaction do nothing?** Its threshold is saved configuration only; compaction execution is not available.
- **Why won't ufAI open?** Check that the local installation is running and that the browser is using its configured address. The documentation cannot establish the current state of the user's machine.
- **Why are models missing?** Check the selected connection and sign-in, refresh its models on Providers, or add a manual model ID there. Discovery results and account access can differ.
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
