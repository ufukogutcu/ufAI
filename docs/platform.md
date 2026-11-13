# ufAI platform guide

## Purpose and current availability

ufAI is a local-first application for one user to organize AI agents and related work across multiple workspaces in a browser. Its intended experience includes configurable agents, communication permissions, reusable skills, instructions, and triggers.

**Current availability: agents, asynchronous collaboration, host tools, terminals, attachments, and native media inputs.** Users can manage workspaces, create agents with saved characters on their flowboards, run separate task conversations, ask for live workload updates, and inspect learned memory. Agent Presets, saved Providers, model discovery/tests, Codex sign-in and usage, Ollama setup, themes, and automatic task-context compaction are available. Ordinary tasks can read/write host files, run commands and interactive terminals, and publish downloadable files. Task messages accept attached files. Supported models can inspect images and open PDFs through their native input capabilities. Agents can contact permitted collaborators and send deliberate messages to your workspace Inbox. Audio/video perception and scheduled/event work remain unavailable. Interfaces, Triggers, skills, and the built-in assistant remain planned. Settings currently contains a heading only.

One local installation holds one shared setup across browser sessions. There are no ufAI application accounts or separate profiles for each browser. Sign-in connects an external provider/runtime account; it does not create a ufAI account. See the [terminology and feature-status guide](README.md) when explaining these distinctions.

## Available capabilities

### runtime-local

- **Status:** implemented
- **Purpose:** Use ufAI locally through a browser.
- **Behavior:** The local application must be running before the browser can open it. The usual address is <http://127.0.0.1:3000>, but an installation may use a different address.
- **Limitations:** The local process and machine must remain available. A page that cannot connect does not establish that saved data has been lost. Remote access and application-account sign-in are not provided.

### saved-data

- **Status:** implemented
- **Purpose:** Keep saved agents, task transcripts, memories, workspaces, Agent Presets, Providers, custom themes, and application preferences on this local installation.
- **Behavior:** Saved records survive closing the browser and restarting ufAI. The selected workspace, active theme, and completed canvas pan/zoom positions are shared across browser sessions. Unsaved forms, open dialogs, and navigation history are temporary.
- **Limitations:** Saving and viewing data requires the local application to be reachable. There is no built-in backup, import, or export tool. Connection credentials and the rest of the saved installation data must be kept together when making a manual backup. Deleting saved records requires confirmation and has no in-app undo.

### dashboard-navigation

- **Status:** implemented
- **Purpose:** Reach Home, Providers, Agent Presets, Theme, and Settings.
- **Behavior:** Use the page icons on the left. Hover or keyboard focus shows their labels. Pages support direct links, refresh, and browser back/forward. The logo opens ufAI's [GitHub project](https://github.com/ufukogutcu/ufAI) in a new tab, keeping the current page and drafts open.
- **Appearance:** Backgrounds and panel surfaces stay steady. Switching workspaces or editors adds a tiny settling movement to foreground content. Dialogs, tooltips, small feedback messages, and individually created list items use brief entrance effects. Initial lists and additional result pages appear immediately. Motion follows the device's reduced-motion preference and does not delay interaction or dismissal.
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
- **Limitations:** Workspaces contain agents and their [flowboards](#agent-canvas). Managed shared folders and Clusters are available. Directed communication permissions are available; scheduled and event workflows remain planned. Deleting a workspace cancels its work and permanently removes its agents, transcripts, memories, and managed files after confirmation. File cleanup may continue after the page closes; failed cleanup offers Retry deletion.

### agent-canvas

- **Status:** partial
- **Purpose:** Provide a visual board for each workspace.
- **Steps:** Drag to pan, scroll to zoom, or use the zoom and reset-view buttons. Each workspace remembers its own completed view changes across reloads and restarts.
- **Limitations:** Choose Add Agent at the upper-right of the workspace area, beside its title, then open its node to configure it or chat. Drag nodes to arrange them, or focus their name button and use arrow keys. Positions are saved after movement. Directed agent communication links are available through handles and canvas controls. Failed position saves offer Retry saves; unsaved positions are not durable until saved.

### agent-characters

- **Status:** implemented
- **Purpose:** Give each agent a recognizable character, body color and accessories.
- **Steps:** New agent shows a suggested character above the name field. Use Edit character to choose Pebble, Sprout, Tiny bot or Droplet, one of six body colors, and any combination of glasses, headphones, cap and star badge. Use character keeps the choice in your draft; Create Agent saves it. For an existing agent, open its panel and choose Edit character beside the header character, then Save character.
- **Behavior:** Suggestions avoid exact appearances already used in the workspace while unused combinations remain, and prefer variety in character types, colors and accessories. There are 384 combinations. Once all are used, suggestions reuse the least-used combinations. Manual choices may match another agent exactly. Cancel discards character editor changes; failed saves keep the draft available to retry.
- **Canvas display:** Characters sit above thin name labels. An unboxed row beneath each label shows a state icon, the number of tasks running right now (including zero), and a Cluster icon when grouped. Canvas controls are beside the character; communication handles are at its sides. Hover or keyboard-focus an indicator for its description; the task-count tooltip also shows queued work. Queued and waiting tasks do not count as running. Long names are shortened on the canvas; hover or focus the name to read it in full.
- **Animation:** Characters appear above canvas name labels and in agent panel headers. They work while the agent is running a task and idle while queued, waiting or otherwise inactive. Use Pause character animations in the bottom canvas controls to pause motion throughout the app; the choice is saved. Reduced-motion preferences also stop character animation. The running-state spinner follows the same pause preference and reduced-motion setting.
- **Limitations:** Dreaming, studying, studying much harder and thinking are reserved for future agent behaviors and cannot be selected in ufAI yet. Character appearance does not change an agent’s permissions, preset or behavior.

### agent-clusters

- **Status:** implemented
- **Purpose:** Group agents into departments within a workspace.
- **Steps:** Choose Add Cluster beside Add Agent. Give it a name and optional description. Drag an agent into its area to join, or outside all Clusters to leave. Each agent belongs to at most one Cluster. Use the canvas-control menu for membership and movement without dragging.
- **Behavior:** Move a Cluster by its header to move its members together. Select its area to expose its bottom-right resize handle, or use its canvas menu to enter a size. Resizing cannot exclude existing members. Moving or resizing a Cluster over other agents does not add them automatically. Color dots and labels identify members; colors are reused when many Clusters exist.
- **Editing and deletion:** Header controls edit the Cluster or show canvas controls. Deleting requires confirmation and permanently deletes its shared files. Active member work and processes stop before cleanup. Member agents, their folders, tasks, histories, and positions are preserved outside the Cluster.
- **Limitations:** Cluster membership grants no additional messaging or tool permission. They are organizational groups, not security sandboxes.

### agent-working-directories

- **Status:** implemented
- **Purpose:** Give workspaces and Clusters shared folders, and agents persistent files with separate working folders for tasks.
- **Steps:** Find a shared-folder path in Edit workspace or Edit Cluster; find agent files in Configuration and a task working folder in its task details. Use Copy path or select the path. Folder setup errors offer a retry.
- **Behavior:** Names and Cluster reassignment do not change these paths. Task follow-ups and retries reuse their task folder; new tasks have separate folders. Confirmed owner deletion permanently removes its managed files. If cleanup fails, retry it from the workspace's deletion progress. Restart continues previously confirmed cleanup.
- **Limitations:** ufAI currently shows paths, not a file browser. Existing computer folders cannot be registered yet. Agents can use these locations through file and command tools and publish downloadable snapshots. Permitted agents can exchange immutable versions through messages. Folders organize files and do not isolate processes.

### agent-configuration

- **Status:** partial
- **Purpose:** Give an agent a persistent name, instructions, and live Agent Preset within one workspace.
- **Steps:** On Home, choose Add Agent beside the workspace title. Enter a name and choose Create Agent. Agent Preset is optional: a saved default is selected automatically, and you can clear it with No preset — choose later. Open the node’s Configuration section to edit its name or preset. An agent may be saved without a complete preset.
- **Instructions:** Ask the agent in an ordinary task to set, revise, or clear its lasting instructions. An agent can save only its own instructions; another agent must request the change through a permitted message. Existing instructions remain saved. Changes apply to subsequent turns, while a running turn keeps its starting instructions. Instructions are no longer entered manually in creation or Configuration.
- **Limitations:** Execution requires an enabled saved model, usable credentials, and a known context window of at least 1,024 tokens. Skills and fine-grained tool permission controls are not implemented; ordinary tasks have host tools. Deleting an agent requires confirmation and permanently removes its work, memory, and agent/task files; published versions stay in the workspace. Failed file cleanup remains visible for retry.

### agent-execution

- **Status:** implemented
- **Purpose:** Run work with host tools in separate task conversations.
- **Steps:** Open an agent, choose Tasks, then New Task. Follow-ups stay in that task. A follow-up to a completed task reopens it. The agent decides whether it has finished or needs another response.
- **Behavior:** One ordinary turn per agent actively runs at a time; a task waiting for a process or agent reply releases its slot so another task can run. Different agents can run concurrently, subject to Provider capacity. Closing the panel or browser does not stop work while the local server and machine remain running. Stop cancels active and queued turns for that task. Retry restarts a failed or blocked attempt using the current preset. Original transcripts remain available after context summaries are made.
- **Recovery:** Queued requests survive a server restart. Interrupted generation requires explicit Retry and can leave an incomplete reply. Deliberately parked messaging waits can resume automatically. An already-saved answer is retained if its later memory update fails.
- **Limitations:** Tool support depends on the selected model; small context windows may not fit the tool definitions and task context. Images and PDFs require compatible models and adapters; agent contact requires a directed communication permission. Host tools use the backend’s OS permissions and are not isolated by agent folders. Replies and summaries can be wrong. Provider errors, output limits, and context limits can interrupt work. Recall, compaction, memory maintenance, and status replies can make extra requests to the selected Provider and consume its usage. Actual work cannot continue while the local backend is stopped or the machine is asleep.

### agent-multimodal-execution

- **Status:** implemented for composer attachments and native image/PDF input.
- **Purpose:** Give an ordinary task durable source files and let supported models inspect actual media.
- **Steps:** Choose Attach Files, drop files into the composer, or paste an image. Selected files stay local until you press Send. A message may contain files without text. Remove a selected file before sending to leave it out. Send transfers the message and all files together; work starts only after every file is saved. Failed sends keep the draft and files for retry while the page remains open.
- **Images:** Images default to Inspect image. If vision support is unknown or unavailable, choose File only to omit automatic visual input, or configure the model in Providers. A file attached this way can still be opened later through the agent’s tools when supported. PNG, JPEG, WebP and GIF native input depend on provider format restrictions. PNG/JPEG/WebP cards offer a larger preview and original download; PDFs, GIFs and active formats are download-only in the browser.
- **PDFs and local files:** Attached PDFs are initially listed as files. Agents can open them on demand when their selected model and integration support native PDF input. Agents can also open supported images/PDFs from host paths; ufAI snapshots those bytes before delivery. Codex currently supports native image input but not PDF input. ufAI does not bundle PDF conversion, OCR, text extraction or page rendering, or automatically install missing host tools.
- **Capabilities:** In Providers, edit a model and set Image input and Native PDF input to Auto, Supported or Unsupported. Auto follows discovered metadata; unknown support stays unavailable. An override cannot enable a format absent from the integration protocol. The ordinary Provider test remains a short text test and does not verify vision.
- **Retention and limits:** Submitted originals remain available until workspace deletion, even after their receiving agent is deleted. Selected but unsent files are not uploaded and are lost when the page is reloaded. Defaults permit ten attachments and 256 MiB combined per message, sharing the installation's artifact quota. Native input permits ten items, 20 MiB each and 32 MiB combined, with tighter provider/context limits. Errors do not silently remove attachments, convert them or substitute another model.
- **Limitations:** Existing workspace outputs cannot yet be selected in the composer. Native PDF opening supplies the whole document; page selection is not provided. Sending bytes does not prove correct understanding. Audio/video perception, dedicated AI image generation/editing, Interfaces and Triggers remain unavailable.

### agent-tool-execution

- **Status:** implemented
- **Purpose:** Let ordinary tasks work with local files and CLI programs.
- **Behavior:** File tools and commands are available to all agents. Commands start in the task’s working folder unless another location is specified. Tool activity records what was requested and its result. Unknown or incompatible tool support is reported as an error rather than silently running a text-only substitute.
- **Processes:** Commands and interactive PTY sessions can remain running after a reply. Open a task’s Processes area to view output, switch to an accessible text log, enable terminal input, send input, or stop a process. A waiting task resumes automatically when its process finishes while other work can run.
- **Limits:** By default, eight processes may run across the installation and two per agent. Ordinary commands have a ten-minute deadline; explicitly backgrounded sessions can run until stopped. Earlier output is trimmed when the retained log fills. Stop on a task cancels that task and its processes. Server shutdown and agent/workspace deletion also stop owned processes. Deliberately detached daemons are outside guaranteed supervision.
- **Recovery:** Interrupted external actions may already have had effects. After restart, inspect activity and use explicit Retry; ufAI does not automatically replay uncertain commands. Status conversations and automatic context/memory maintenance have no host tools.

### agent-artifacts

- **Status:** implemented
- **Purpose:** Keep durable, downloadable versions of files produced by agents.
- **Behavior:** An agent publishes a snapshot of a stable regular file. Task file cards and the workspace’s Published Files panel show its name, size, availability, and Download action. Changing the working file does not change an already published version. An agent can make a task-local working copy and publish another version.
- **Retention:** Published files remain available after their agent and working folders are deleted. Deleting the workspace permanently removes them. Missing published bytes are shown as unavailable; ufAI never substitutes another file with the same filename.
- **Limits:** Defaults are 256 MiB per version, two simultaneous publications, and 10 GiB of managed artifact storage. Publication errors remain visible. Downloading or transferring bytes does not mean the selected model visually inspected the file. Task attachments and PNG/JPEG/WebP previews are available. Other formats remain downloadable; native inspection depends on model support.

### agent-status

- **Status:** implemented
- **Purpose:** Ask what an agent is doing without interrupting its ordinary task.
- **Steps:** Open Overview, inspect the live workload, or ask a natural-language question in Ask status. Select a listed task to inspect its conversation.
- **Behavior:** The status conversation reads a timestamped workload snapshot and recent summaries. It cannot change ordinary tasks or learned memory.
- **Limitations:** Status responses share Provider capacity and may wait. Running means execution is active; it is not a promise of progress or success. Status questions in a normal task composer join that task’s queue instead.

### agent-memory

- **Status:** partial
- **Purpose:** Carry useful preferences and past findings between an agent’s isolated tasks.
- **Behavior:** The agent automatically maintains a work summary and may learn lasting preferences or findings after successful replies. New tasks receive bounded shared memories and can retrieve relevant history. Memory entries link to source messages; findings are not independently verified.
- **Steps:** Open Memory to inspect entries, view their sources, edit them, or choose Forget. Forgetting an entry preserves its original transcript and suppresses automatic updates to that remembered topic.
- **Limitations:** Recall is selective and does not guarantee every relevant past detail will be found. Memory is scoped to one agent. A memory update can fail without losing the answer. Editing memory does not edit the agent’s configured instructions or grant permissions.

### agent-compaction

- **Status:** implemented
- **Purpose:** Keep long task context within the selected model’s saved capacity.
- **Behavior:** Older complete exchanges are summarized automatically at the preset threshold or an earlier safety limit. An empty threshold uses 80%. Recent context and the new input remain available, while original transcripts stay saved.
- **Limitations:** Summaries can lose details. An unknown capacity must be configured on Providers before running. If a summary fails or the task still cannot fit, Retry or start a smaller New Task. Saved capacity does not enlarge the actual model window.

### model-presets

- **Status:** partial
- **Purpose:** Save reusable Agent Presets shared across workspaces. The capability ID remains `model-presets`.
- **Steps:** Open Agent Presets. The top preset opens automatically, or the last opened preset when returning during the same app session. Reloading resets this selection memory. If that preset was removed while away, the top remaining preset opens. When the library is empty, the new preset form opens automatically. Choose New preset to create another. Enter a name. Optionally select a saved Provider, one of its saved models, and a compaction threshold. Provider setup and model editing belong on [Providers](#provider-connections).
- **Default preset:** Check Use as default for new agents and save to select the installation-wide default. Saving another default replaces the previous one. Unchecking or deleting the default leaves none; upgrading does not choose one automatically. New agent forms select the default, including presets beyond the first library page. You can select a different preset or leave it empty. Changing the default never reassigns existing agents. A default may be incomplete and still needs a Provider, model, and known context window before tasks can run.
- **Model context:** The selected model's current context window is shown read-only. Edit that shared value in Providers; every preset using that Provider/model sees the changes.
- **Compaction:** Leave the threshold empty for no configuration, or enter a percentage from 1–100 or a positive whole token count. Percentage thresholds round down with a minimum of one token; unknown context displays Unknown. Changing the threshold unit clears its value. A threshold exceeding known context shows a warning and can still be saved.
- **Saving:** Only the name is required. Save stores the preset; failed saves retain the draft. Cancel and navigation protect unsaved edits. Returning to the library keeps it visible until you choose an item or revisit the page. Deletion requires confirmation; deleting the open preset opens the top remaining preset, or a new form if none remain. Deleting its Provider clears Provider/model selections; removing its model clears only the model selection. Names and compaction are preserved.
- **Upgrade behavior:** Previously linked presets keep their Provider/model choices. Older unlinked presets retain their names and compaction, with Provider/model fields cleared. Conflicting historical model context windows are shown for review in Providers.
- **Limitations:** Presets supply live model/runtime and compaction choices to linked agents. Editing a preset affects later turns, while a running turn keeps its starting configuration. Incomplete presets may be saved but cannot run; deleting a preset leaves linked agents needing a new selection. Changes from other sessions refresh on returning to the page; unsaved drafts remain protected.

### provider-connections

- **Status:** implemented
- **Purpose:** Set up named Provider configurations, maintain their model lists, and test model replies.
- **Steps:** Open Providers. The top Provider opens automatically, or the last opened Provider when returning during the same app session. Reloading resets this selection memory. If that Provider was removed while away, the top remaining Provider opens. When the library is empty, the creation form opens automatically. Choose New Provider to create another. Choose the API, Subscription, or Local tab, then select a provider tile to reveal its name, connection fields, and models. New forms open on API with nothing selected. API offers OpenAI, Anthropic, Google Gemini, OpenRouter, xAI, DeepSeek, Mistral, Groq, Together, and Custom OpenAI-compatible; Subscription offers Codex; Local offers Ollama. Multiple named configurations of the same type are supported. Opening a Provider only selects its editor. Choose the Provider explicitly in each Agent Preset; there is no default or automatic fallback configuration.
- **Provider choice:** Before setup creates a record, switching category clears the provider selection and preserves the name. Selecting a provider fills the name with its tile title and keeps it following type changes until you enter a nonempty name yourself. Clearing the name, including leaving only spaces, restores automatic naming on later type selections. Switching provider clears connection fields and errors while preserving custom names. Once setup begins, category and provider are fixed. Create a new Provider to choose another type. Save is available only after choosing a provider.
- **Connection setup:** Named API services require an API key. Custom OpenAI-compatible servers require their API base URL and may use a key. Ollama normally uses `http://localhost:11434`, accepts another server URL, and does not normally require a key. Use Connect & load models to apply connection settings and try discovery. For [Codex](#runtime-connections), sign in with ChatGPT.
- **Saving:** A new Provider appears in the library and its count only after Save Provider succeeds with at least one checked model, discovered or manually added. Connecting, signing in, fetching models, and testing keep setup open in the editor without adding a library entry. Unselecting every model temporarily is allowed, but Save Provider requires at least one selected model. Discovery and testing do not have to succeed. Unfinished setup is excluded from both the Provider library and Agent Preset choices. Failed saves retain the open setup for correction or retry. Cancelling a new setup discards its setup credentials; interrupted setups may remain stored locally but are hidden from the library and cannot be resumed there. Returning to the library keeps it visible until you choose an item or revisit the page. Deleting the open Provider opens the top remaining Provider, or a new form if none remain.
- **Models:** Refresh models tries discovery again and merges newly available models. Existing entries, manually added IDs, and explicit context overrides are retained. Models omitted from a refresh remain listed with an indication. Search and page controls help browse long lists. Compact rows provide icon buttons for Edit and Test; expand model details to read test results and additional warnings. Check the models you want offered when choosing a model from this Provider. Unchecked models remain here for editing and testing. Select all and Unselect all affect every search match across all pages, or the entire catalog when search is empty. Checkbox changes take effect only with Save Provider, and remain in your draft while searching, paging, editing a model, or refreshing. If unchecking models affects existing Agent Presets, saving asks for confirmation and names affected presets; confirming clears their model choices while keeping their Provider and compaction settings. Cancelling the confirmation leaves saved choices unchanged. Refresh preserves saved checkbox choices and selects newly discovered models. Add model accepts an exact model ID without checking upstream availability.
- **Context:** Edit a model to see its automatic context window and optionally override it. A blank override uses the automatic value, which remains Unknown when unavailable. Refresh updates automatic context values for existing models, including previously Unknown values, while retaining manual overrides. When a known fetched context differs from a manual context, a warning beside the model shows both values. Choose Use automatic context to save that change immediately and follow future automatic updates; unsaved Provider changes are preserved. Failed changes leave the manual context in place and show an error beside the action. Reset context to automatic in Edit clears the context override when saved. Model changes save independently of the connection form.
- **Testing:** Test sends “Reply with OK.” through the selected model. A nonempty completed assistant reply confirms that it answered; the exact wording can differ. The latest result shows its time, duration, and a short reply or error. Tests may consume provider usage. Tests have a two-minute deadline and can be cancelled; replacing credentials or endpoints clears previous results. A successful test does not measure the configured context capacity or guarantee future access.
- **Privacy:** Credentials stay on the local backend. Saved API keys are encrypted and never returned to the browser. Provider records belong to the shared local installation. Deleting a Provider removes its local model records and credentials; it does not revoke an upstream API key.
- **Limitations:** Discovery requires a reachable service and credentials where applicable. A model appearing in a catalog is not proof of account access. Discovery failures leave the previous saved list intact. Custom and Ollama endpoints require HTTPS except for loopback HTTP. To use a saved Provider for tasks, select it in an Agent Preset and link that preset to an agent.

### runtime-connections

- **Status:** partial
- **Purpose:** Connect Codex using a ChatGPT subscription for model discovery, short model tests, and agent tasks with ufAI-managed tools.
- **Steps:** Create a Codex configuration on Providers and choose Sign in with ChatGPT. Follow Continue to ChatGPT and return after sign-in. A device code is an alternative. After sign-in, ufAI tries to load models. Reconnect, cancel sign-in, or sign out from the same page.
- **Behavior:** Codex is bundled with ufAI; a separate global CLI installation is not required. Model testing creates a temporary conversation solely for the short prompt. Signing out clears prior model-test results but keeps model configurations and preset bindings.
- **Model context:** Discovery uses each model's default context window from the Codex catalog for that Provider, with bundled defaults as a fallback. Refresh models updates existing saved models. Context remains Unknown if neither catalog supplies a valid value. Explicit context overrides are retained. These values describe catalog defaults; they do not enlarge the model’s actual capacity. Agents use the saved value to budget and compact their task context.
- **Limitations:** Account entitlement and the bundled runtime determine availability. A subscription does not imply access to the separate OpenAI API. Task conversations use ufAI-managed file, command, process, and artifact tools through saved Agent Presets. Native Codex tools and collaboration remain disabled; status and model tests stay text-only. The pinned runtime does not expose a hard output-token setting; replies use a requested budget, a text-size limit, and cancellation.

### codex-usage-dock

- **Status:** implemented
- **Purpose:** Inspect subscription usage separately for each saved Codex Provider and use eligible earned resets.
- **Steps:** Save a Codex Provider to see its usage button beneath the page icons on the left. The two menus are centered together; long usage lists scroll, and the entire stack can scroll on short screens. Each button shows percent remaining for the account's reported default windows, such as 5h and 7d, or only 7d when that is all the account supplies. Hover or keyboard focus shows the Provider name, plan, credits, reset countdowns, and last update. Select the button to open detailed usage without leaving the current page or losing form drafts.
- **Details:** The dialog shows every reported quota bucket, remaining percentages, exact reset times, available credit information, and an earned-reset count with any supplied individual details. Unknown values stay unknown. Disconnected Providers remain visible with a sign-in indicator; sign in from Providers. Setup drafts do not appear in the usage menu.
- **Refresh:** Usage refreshes when the app opens, when you return to a visible tab, when details open, and every minute while the tab is visible. Refresh in the dialog requests a fresh snapshot. A failed refresh keeps previous data with an error and its original update time. A countdown reaching zero requests another check; it does not establish that access has recovered.
- **Use a reset:** Choose Use reset beside an available, unexpired Codex reset, then confirm consumption. When individual details are unavailable, Use next available reset lets Codex choose one. The dialog waits for the result before allowing dismissal. An uncertain request offers Retry previous reset attempt, which checks the same logical redemption rather than spending another reset. Do not assume success from a network error; refresh usage and read the returned result.
- **Limitations:** Resets affect eligible windows only. Codex may report no eligible window or no remaining reset. Detail lists may be incomplete even when the available count is known. Credit balances and earned resets are different; credit purchasing, automatic reset use, and token-history analytics are not provided. Multiple Providers connected to the same external account share that account's actual allowance. Usage snapshots and open dialogs are temporary.

## Common questions

- **Why is the board empty?** Add Agent creates an agent in the selected workspace. Creating a workspace or preset alone does not create an agent.
- **Why is a task blocked?** Open its error details. Choose a complete Agent Preset, enable its model, set an unknown context window on Providers, or reconnect credentials as needed, then use Retry. ufAI never silently selects another Provider.
- **Why won't ufAI open?** Check that the local installation is running and that the browser is using its configured address. The documentation cannot establish the current state of the user's machine.
- **Why are models missing?** Check the selected connection and sign-in, and make sure the model is checked and saved on Providers. You can also refresh its models or add a manual model ID there. Discovery results and account access can differ.
- **Why did my theme or workspace change in another browser?** All sessions share the same local setup. There are no separate per-browser accounts or preference profiles.
- **What should I do after a save fails?** Keep the draft open and use Retry or save again when the local installation is reachable. Do not treat a failed save as confirmed or delete saved data to resolve it.
- **Can I export or automatically back up my setup?** No built-in export or backup tool is provided. Preserve all saved installation data and connection credentials together when making a manual backup.

## Agent collaboration

### agent-messaging

- **Status:** implemented
- **Purpose:** Delegate work asynchronously, exchange questions and files, and return results to the correct requester.
- **Setup:** Allow communication from an agent’s canvas controls, or connect its outgoing handle to another agent’s incoming handle. The arrow allows its source to initiate contact with its destination. Cluster membership grants no communication permission. Accepted requests allow scoped replies in both directions.
- **Behavior:** Each request creates a separate helper task. Multiple requests queue independently; one ordinary task runs per agent at a time. Sending returns immediately. An agent can continue independent work or wait for one or several helpers. Waiting releases execution capacity, allowing other work to run. User work gets preference, with helper work admitted regularly to prevent starvation.
- **Replies:** A helper’s final answer returns to its requesting agent automatically. Questions can wake the requester; progress updates remain in history. The original user task keeps its user conversation. Task details show the communication history, request state, helper execution errors, and controls for opening the participating tasks.
- **Files:** Messages can carry ordered immutable file versions. Published Files remains shared within a workspace. Uploaded files and private inspection snapshots are available through ufAI tools only to their owning task and explicit recipients. A recipient can materialize a working copy or open supported native media. Receiving a file does not mean the model inspected it. Shared bytes remain available after their producer is deleted, until workspace deletion.
- **Cancellation and recovery:** Cancelling a parent task leaves helpers running; their results remain recorded and do not restart the cancelled parent. Cancelling a helper returns a cancellation outcome. Deliberate messaging waits survive restart; generation interrupted outside a saved wait still requires explicit Retry. Known or uncertain host actions are not automatically repeated.
- **Removing permission:** Review and confirm the affected requests and processes before removing a link. ufAI stops affected helper work and its delegated descendants, retaining messages, working files, and published outputs. Unrelated work continues. Failed removal is visible from the link editor and can be retried. Finish or retry an unfinished link removal before deleting either endpoint agent. Recreating a link does not reopen revoked requests. You can explicitly continue a retained task yourself after removal finishes; that does not restore the revoked agent conversation.
- **Limits:** Communication stays within one workspace. Delegation has bounded depth, fan-out, queues, and deadlines. Requests default to a one-hour deadline and may use up to 24 hours. Long forwarded answers may arrive as clearly marked excerpts; their full answers remain in the source task. Full-host commands still use the installation’s OS permissions: these folders and application permissions are not a filesystem sandbox.

### workspace-inbox

- **Status:** implemented
- **Purpose:** Receive deliberate agent notifications without mixing them with normal task answers.
- **Behavior:** Open the workspace Inbox beside Published Files. Messages show their source, files, time, and saved read/unread state. Open the source task or reply with text and files through the ordinary single-Send composer. Replies go to that task, and its answer returns to the Inbox. This does not change the return route of a separate pending agent request.
- **Limitations:** Ordinary helper results do not create Inbox notifications automatically. If the source task or agent was deleted, its retained message remains readable but cannot receive a reply. External notifications through Telegram, Discord, or other Interfaces remain planned.

## Planned capabilities

These capabilities are not available yet. This is product direction, not a release schedule.

| Capability ID | Status | Intended purpose | Current limitation |
| --- | --- | --- | --- |
| `agent-triggers` | planned | Start work on a schedule or from events | Manual task conversations exist; schedules and event Triggers are unavailable |
| `agent-interfaces` | planned | Contact agents through services such as Telegram or Discord | Only ufAI conversations are available |
| `platform-assistant` | planned | Help users understand ufAI and configure their workspaces | No built-in assistant or automatic use of these documents is connected yet |
