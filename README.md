# ufAI

An open-source, local-first application for one user to organize AI agents in multiple workspaces through a browser interface. One local backend and SQLite database hold the shared setup across browser sessions.

**Status: early functional dashboard.** The application includes floating page navigation, saved workspace tabs with empty pannable flowboards, project-wide Agent Presets and Providers libraries, and locked light/dark defaults with custom themes backed by SQLite. Settings is an empty page. Saved API connections, bundled Codex subscription sign-in, dedicated Ollama setup, model discovery/manual catalogs, shared model limits, and short model tests are available on Providers. Agent editing/execution, general inference, compaction execution, skills, messaging, and triggers remain planned.

## Stack

- TypeScript throughout
- React and Vite for the browser UI
- Fastify on Node.js for the application server
- SQLite via `better-sqlite3` for local persistence
- npm workspaces for the repository structure
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
data/                 Generated local database; ignored by Git
```

API keys are encrypted using a local key under `<database filename>.connections/`; Codex maintains isolated sign-in credentials inside that directory. Keep it with the database when backing up or moving ufAI, and keep these generated files out of Git.

SQLite is created at `data/ufai.sqlite` on server startup, with WAL mode and foreign-key enforcement enabled. Versioned migrations create workspace, Agent Preset, Provider/model catalog, theme, application-settings, and viewport tables, and seed one Default workspace once. Deleting the last workspace leaves an empty state; restarting does not recreate it. The connection closes during graceful shutdown.

## Dashboard

- **Home:** create, rename, and delete workspaces; switch between empty flowboards with pan, zoom, and reset controls. Board viewports are saved per workspace in SQLite after pan/zoom interactions.
- **Providers:** configure named API, Codex subscription, custom OpenAI-compatible, and local Ollama connections. Discover or manually add models, refresh the saved catalog, edit shared context/output limits, and send a short test prompt. Saving requires at least one model, while discovery and testing remain optional. Codex is bundled and needs no separate CLI install.
- **Agent Presets:** create, edit, and delete reusable agent configurations. Only a name is required; choose a saved Provider/model and optional percentage or absolute-token compaction threshold when ready. Model limits are shared through Providers. These presets do not execute agents or compaction.
- **Theme:** permanent Light Mode and Dark Mode, a shared Light Mode default, and custom theme creation/duplication/editing with a contained visual preview. Custom themes and the active selection persist in SQLite for the whole local setup.
- **Settings:** empty page reserved for later work.

Pages use hash URLs, including `#/home`, `#/providers`, and `#/agent-presets` (`#/model-presets` remains an alias). Workspace, preset, and custom theme records survive server restarts. Selected-workspace, active-theme, and canvas viewport preferences also survive restarts in SQLite. Settings load on open and refresh when returning to a tab. Old browser preferences are ignored; new settings start with Light Mode and the first existing workspace. Unsaved drafts and URL history remain temporary. Application accounts and multi-user tenancy are outside the product scope.

`npm test` runs API/database integration, client-state, theme/settings/catalog, provider catalogs, model tests, discovery/Codex lifecycle, and preset calculation/validation checks using temporary databases.

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

The server binds to loopback by default. Authentication and remote access are not configured. Keep the default loopback binding for local use.

## License

[MIT](LICENSE). Copyright (c) 2026 ufukogutcu. Bundled dependencies retain their own licenses; `@openai/codex` is Apache-2.0 licensed.
