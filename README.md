# ufAI

An open-source, local-first application for organizing AI agents in multiple workspaces through a browser interface.

**Status: initial scaffold.** This repository currently contains a placeholder React page, a Fastify health endpoint, and SQLite connection initialization. Agent orchestration, provider integrations, workspaces, visual node editing, skills, messaging, and triggers are planned and are not implemented.

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
npm run build
npm start
```

Open <http://127.0.0.1:3000>. Fastify serves the compiled React application and API from one server and one port. Vite is only needed during development and build time.

## Structure

```text
apps/
  server/
    src/
      database.ts     SQLite connection initialization
      index.ts        Fastify entry point and health endpoint
  web/
    src/              Placeholder React application
    vite.config.ts    Development server and API proxy
data/                 Generated local database; ignored by Git
```

SQLite is created at `data/ufai.sqlite` on server startup, with WAL mode and foreign-key enforcement enabled. There are no application tables or migrations yet. The connection closes during graceful shutdown.

## Configuration

Set environment variables in the shell before starting the application. `.env` files are not loaded automatically.

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Fastify bind address |
| `PORT` | `3000` | Fastify port; also used by the development API proxy |
| `WEB_PORT` | `5173` | Vite development server port |
| `DATABASE_PATH` | Repository-root `data/ufai.sqlite` | SQLite file path; relative paths resolve from the server process's working directory |

The server binds to loopback by default. Authentication and remote access are not configured in this scaffold.

## License

[MIT](LICENSE). Copyright (c) 2026 ufukogutcu.
