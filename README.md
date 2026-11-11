# ufAI

An open-source, local-first application for organizing AI agents in multiple workspaces through a browser interface.

**Status: early functional dashboard.** The application includes collapsible navigation, saved workspace tabs with empty pannable flowboards, and a project-wide model preset library backed by SQLite. Theme and Settings are empty pages. Provider connections, automatic model discovery, sign-in, agent editing/execution, compaction execution, skills, messaging, and triggers remain planned.

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
      app.ts          Health, workspace and preset routes
      contracts.ts    API types shared with the browser through type-only imports
  web/
    src/              React dashboard, flowboards and preset editor
    vite.config.ts    Development server and API proxy
data/                 Generated local database; ignored by Git
```

SQLite is created at `data/ufai.sqlite` on server startup, with WAL mode and foreign-key enforcement enabled. Versioned migrations create workspace and model preset tables, and seed one Default workspace once. Deleting the last workspace leaves an empty state; restarting does not recreate it. The connection closes during graceful shutdown.

## Dashboard

- **Home:** create, rename, and delete workspaces; switch between empty flowboards with pan, zoom, and reset controls. Board viewports last for the current browser session.
- **Model Presets:** create, edit, and delete shared model configurations. Metadata is entered manually; no credentials are collected. Compaction defaults to 80% of context and can use an absolute token limit instead. These values are configuration only.
- **Theme / Settings:** empty pages reserved for later work.

Pages use hash URLs, including `#/home` and `#/model-presets`. Workspace and preset records survive server restarts. Sidebar and selected-workspace preferences are browser-local.

`npm test` runs API/database integration checks and preset calculation/validation checks using temporary databases. See the [HTTP API reference](docs/api.md) for request and response contracts.

## Agent documentation

Coding agents should start with [AGENTS.md](AGENTS.md) and the [documentation index](docs/README.md). The [platform guide](docs/platform.md) describes verified capabilities, setup, limitations, and future product direction; the [architecture reference](docs/architecture.md) explains implementation details and boundaries.

These references are maintained alongside relevant changes. They are intended for coding agents and as source material for a future in-app assistant; assistant integration is not implemented.

## Configuration

Set environment variables in the shell before starting the application. `.env` files are not loaded automatically.

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Fastify bind address |
| `PORT` | `3000` | Fastify port; also used by the development API proxy |
| `WEB_PORT` | `5173` | Vite development server port |
| `DATABASE_PATH` | Repository-root `data/ufai.sqlite` | SQLite file path; relative paths resolve from the server process's working directory |

The server binds to loopback by default. Authentication and remote access are not configured. Keep the default loopback binding for local use.

## License

[MIT](LICENSE). Copyright (c) 2026 ufukogutcu.
