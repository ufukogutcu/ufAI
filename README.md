# ufAI

An open-source, local-first application for one user to organize AI agents in multiple workspaces through a browser interface. One local backend and SQLite database hold the shared setup across browser sessions.

**Status: agent execution, host tools, terminals, attachments, and native media inputs.** Workspaces contain visual department Clusters, managed shared/agent/task folders, canvas agents with live Agent Preset links, separate task chats, a read-only workload/status chat, automatic shared memory, and context compaction. Saved Providers cover all existing API types, Ollama, and bundled Codex. Navigation, themes, model catalogs, prompt tests, and Codex subscription usage remain available. Ordinary agent tasks can use host file tools, commands, interactive terminals, and immutable downloadable file outputs. Waiting tasks release execution capacity. Users can attach files to task messages, send images to supported vision models, and let agents open images/PDFs through native provider inputs. Skills, agent-to-agent messaging, Interfaces, Triggers, audio/video perception, and dedicated image generation remain planned.

Agents run with the backend’s OS permissions. Their folders organize work and are not sandboxes. Published versions survive agent deletion and are permanently removed with their workspace. Background processes stop on task cancellation, owner deletion, or server shutdown; deliberately detached host daemons are outside guaranteed supervision.

PTY support uses native bindings. A platform without a matching prebuilt binding needs the native build prerequisites required by `node-pty`.

Select files in the task composer, then press Send once. Images default to Inspect image; File only sends a durable file reference without visual input. Model image/PDF capabilities can be discovered or overridden in Providers. Unknown capability does not enable inspection. PDF opening depends on the selected model and adapter; the pinned Codex protocol accepts images, not PDFs. ufAI does not install conversion tools or provide OCR/page rendering. Native inspection is limited to ten items, 20 MiB per item and 32 MiB combined, with tighter provider limits applied. Browser image previews cover PNG/JPEG/WebP; other formats remain downloadable.

## Stack

- TypeScript throughout
- React and Vite for the browser UI
- Fastify on Node.js for the application server
- SQLite via `better-sqlite3` for local persistence
- npm workspaces for the repository structure
- `node-pty` for native terminal sessions and lazy-loaded xterm.js for terminal display
- MIT license

## Requirements

- Node.js 22.12 or newer (Node.js 22 LTS recommended; `.nvmrc` is included)
- npm

## Development

From the repository root:

```sh
npm ci
npm run dev
```

- Browser UI: <http://127.0.0.1:5173>
- Server health: <http://127.0.0.1:3000/api/health>
- The UI development server proxies `/api` requests to Fastify.
- Both development servers restart or reload as source files change.

## Build and run

```sh
npm run typecheck
npm test
npm run build
npm start
```

Open <http://127.0.0.1:3000>. Fastify serves the compiled React application and API from one server and one port. Vite is only needed during development and build time.

## Structure

```text
apps/
  server/
    src/
      database.ts     SQLite initialization and versioned migrations
      index.ts        Fastify process entry point
      app.ts          Health, workspace and preset routes; theme registration
      contracts.ts    API types shared with the browser through type-only imports
  web/
    src/              React dashboard, flowboards, preset and theme editors
    vite.config.ts    Development server and API proxy
packages/
  theme-catalog/      Shared color tokens, editor metadata and default palettes
data/                 Generated local database and managed files; ignored by Git
```

API keys are encrypted using a local key under `<database filename>.connections/`; Codex maintains isolated sign-in credentials inside that directory. Keep it with the database when backing up or moving ufAI, and keep these generated files out of Git. Managed files default to `<absolute database filename>.files/`; `UFAI_FILES_ROOT` can select a different root. Preserve that root, including its ownership marker, with installation backups. Relative overrides resolve from the server working directory; `.env` files are not automatically loaded.

SQLite is created at `data/ufai.sqlite` on server startup, with WAL mode and foreign-key enforcement enabled. Versioned migrations create workspace, Agent Preset, Provider/model catalog, theme, application-settings, viewport, agent, task, transcript, memory, execution-event, Cluster, managed-location, and file-deletion tables, and seed one Default workspace once. Deleting the last workspace leaves an empty state; restarting does not recreate it. The connection closes during graceful shutdown.

## Dashboard

- **Home:** create, rename, and delete workspaces; create and position agents on flowboards, then open their task, status, memory, and configuration panels. Pan, zoom, and reset controls remain available. Board viewports are saved per workspace in SQLite after pan/zoom interactions. Add Cluster creates a department; drag agents into or out of groups, or use their canvas menus. Each agent belongs to at most one Cluster. Group movement carries its members. Folder paths can be copied from workspace/Cluster editing, agent configuration, and task details. Deletion warns about permanent file removal and continues on the server, with retryable cleanup failures. Deleting a Cluster keeps its agents and their files/history. Folders do not enable model file access or act as sandboxes.
- **Providers:** configure named API, Codex subscription, custom OpenAI-compatible, and local Ollama connections. Discover or manually add models, refresh the saved catalog, edit shared context windows, and send a short test prompt. Saving requires at least one model, while discovery and testing remain optional. Codex is bundled and needs no separate CLI install.
- **Agent Presets:** create, edit, and delete reusable agent configurations. Only a name is required; choose a saved Provider/model and optional percentage or absolute-token compaction threshold when ready. Model context windows are shared through Providers. Agents link to presets; edits apply to later turns. Incomplete presets cannot run. Compaction is automatic during long tasks.
- **Theme:** permanent Light Mode and Dark Mode, a shared Light Mode default, and custom theme creation/duplication/editing with a contained visual preview. Custom themes and the active selection persist in SQLite for the whole local setup.
- **Settings:** empty page reserved for later work.

Pages use hash URLs, including `#/home`, `#/providers`, and `#/agent-presets` (`#/model-presets` remains an alias). Workspace, preset, and custom theme records survive server restarts. Selected-workspace, active-theme, and canvas viewport preferences also survive restarts in SQLite. Settings load on open and refresh when returning to a tab. Old browser preferences are ignored; new settings start with Light Mode and the first existing workspace. Unsaved drafts and URL history remain temporary. Application accounts and multi-user tenancy are outside the product scope.

`npm test` runs API/database integration, client-state, theme/settings/catalog, provider catalogs, model tests, discovery/Codex lifecycle, and preset calculation/validation, durable execution, memory/compaction, streaming adapters, Codex turn isolation, SSE reconnect, managed-folder migration/recovery, confirmed file deletion, and Cluster/client-layout checks using temporary databases and protocol fixtures.

## Knowledge for ufAI app agents

The [app-agent knowledge index](docs/README.md) and [platform guide](docs/platform.md) explain ufAI's purpose, available features, user workflows, and limitations. `docs/` is exclusively for agents inside ufAI helping users understand and use the application; it is not an engineering reference or design manual.

The built-in assistant and automatic use of these documents are not implemented.

## Local developer-agent guidance

Coding agents use the local `AGENTS.md` entry point and `.agents/developer/README.md`. Architecture, API references, design rules, skills, and other developer-agent material live under `.agents/` and are intentionally ignored by Git. They are not included in fresh clones. The standard project README, application code/tests, and app-agent knowledge remain versioned.

## Configuration

Set environment variables in the shell before starting the application. `.env` files are not loaded automatically.

| Variable | Default | Description |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `HOST` | `127.0.0.1` | Fastify bind address |
| `PORT` | `3000` | Fastify port; also used by the development API proxy |
| `WEB_PORT` | `5173` | Vite development server port |
| `DATABASE_PATH` | Repository-root `data/ufai.sqlite` | SQLite file path; relative paths resolve from the server process's working directory |
| `UFAI_FILES_ROOT` | `<absolute database filename>.files` | Managed working folders and published artifacts; separate from credentials |
| `UFAI_ARTIFACT_MAX_BYTES` | `268435456` (256 MiB) | Maximum bytes per artifact version |
| `UFAI_ARTIFACT_STORAGE_BYTES` | `10737418240` (10 GiB) | Managed artifact quota, including pending reservations |
| `UFAI_ARTIFACT_INGESTS` | `2` | Concurrent artifact ingests and maximum incoming transfers |
| `UFAI_UPLOAD_MAX_FILES` | `10` | Attachments per message (maximum configurable value: 100) |
| `UFAI_UPLOAD_MAX_BYTES` | `268435456` (256 MiB) | Combined attachment bytes per message, also subject to artifact limits |

The server binds to loopback by default. Authentication and remote access are not configured. Keep the default loopback binding for local use.

## License

[MIT](LICENSE). Copyright (c) 2026 ufukogutcu. Bundled dependencies retain their own licenses; `@openai/codex` is Apache-2.0 licensed.
