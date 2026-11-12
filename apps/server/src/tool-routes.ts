import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { AgentExecution } from "./agent-execution.js";
import type { ProcessService } from "./process-service.js";
import type { ArtifactService } from "./artifact-service.js";
import { guard } from "./connections.js";
import { pagination, objectBody, InputError } from "./validation.js";
import { validateTool } from "./agent-tools.js";
import { ConnectionError } from "./model-providers.js";
export function registerTools(
  app: FastifyInstance,
  db: Database.Database,
  execution: AgentExecution,
  processes: ProcessService,
  artifacts: ArtifactService,
) {
  app.addHook("onRequest", async (req) => {
    const route = req.routeOptions.url ?? req.url;
    if (
      /^\/api\/(processes|artifact-versions)(\/|\?|$)/.test(route) ||
      /^\/api\/(tasks|workspaces)\/[^/]+\/(activity|processes|artifacts)(\/|\?|$)/.test(
        route,
      )
    )
      guard(req);
  });
  const workspace = (id: string) => {
    if (!db.prepare("SELECT id FROM workspaces WHERE id=?").get(id))
      throw new ConnectionError("Workspace not found.", 404);
  };
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/activity",
    async (req) => {
      execution.task(req.params.id);
      const { limit, offset } = pagination(req.query);
      const after = Number((req.query as { after?: string }).after ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new InputError({ after: "Use a nonnegative sequence cursor." });
      return {
        items: db
          .prepare(
            after
              ? "SELECT * FROM execution_items WHERE taskId=? AND sequence>? ORDER BY sequence LIMIT ? OFFSET ?"
              : "SELECT * FROM execution_items WHERE taskId=? AND sequence>? ORDER BY sequence DESC LIMIT ? OFFSET ?",
          )
          .all(req.params.id, after, limit, offset),
        total: (
          db
            .prepare("SELECT count(*) AS n FROM execution_items WHERE taskId=?")
            .get(req.params.id) as { n: number }
        ).n,
      };
    },
  );
  for (const kind of ["tasks", "workspaces"] as const) {
    app.get<{ Params: { id: string } }>(
      `/api/${kind}/:id/processes`,
      async (req) => {
        if (kind === "tasks") execution.task(req.params.id);
        else workspace(req.params.id);
        const { limit, offset } = pagination(req.query),
          key = kind === "tasks" ? "taskId" : "workspaceId";
        return {
          items: db
            .prepare(
              `SELECT * FROM owned_processes WHERE ${key}=? ORDER BY createdAt DESC,id LIMIT ? OFFSET ?`,
            )
            .all(req.params.id, limit, offset),
          total: (
            db
              .prepare(
                `SELECT count(*) AS n FROM owned_processes WHERE ${key}=?`,
              )
              .get(req.params.id) as { n: number }
          ).n,
        };
      },
    );
    app.get<{ Params: { id: string } }>(
      `/api/${kind}/:id/artifacts`,
      async (req) => {
        if (kind === "tasks") execution.task(req.params.id);
        else workspace(req.params.id);
        const { limit, offset } = pagination(req.query),
          key = kind === "tasks" ? "producerTaskId" : "workspaceId";
        return {
          items: db
            .prepare(
              `SELECT * FROM artifact_versions WHERE ${key}=? ORDER BY createdAt DESC,id LIMIT ? OFFSET ?`,
            )
            .all(req.params.id, limit, offset),
          total: (
            db
              .prepare(
                `SELECT count(*) AS n FROM artifact_versions WHERE ${key}=?`,
              )
              .get(req.params.id) as { n: number }
          ).n,
        };
      },
    );
  }
  app.get<{ Params: { id: string } }>("/api/processes/:id", async (req) =>
    processes.get(req.params.id),
  );
  app.get<{
    Params: { id: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/api/processes/:id/output", async (req) => {
    const cursor = Number(req.query.cursor ?? 0),
      limit = Number(req.query.limit ?? 65536);
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 65536
    )
      throw new InputError({ cursor: "Invalid output cursor or limit." });
    return processes.output(req.params.id, cursor, limit);
  });
  app.post<{ Params: { id: string } }>(
    "/api/processes/:id/input",
    async (req, reply) => {
      const a = objectBody(req.body);
      validateTool("process_input", { processId: req.params.id, ...a });
      processes.input(req.params.id, a.data as string);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/processes/:id/resize",
    async (req, reply) => {
      const a = objectBody(req.body);
      validateTool("process_resize", { processId: req.params.id, ...a });
      processes.resize(req.params.id, a.cols as number, a.rows as number);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>("/api/processes/:id/stop", async (req) =>
    processes.stop(req.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/artifact-versions/:id",
    async (req) => artifacts.get(req.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/artifact-versions/:id/content",
    async (req, reply) => {
      const { version, stream } = await artifacts.download(req.params.id);
      const name = version.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(version.name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
      );
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Cache-Control", "no-store");
      reply.header("Content-Length", version.size);
      return reply.type("application/octet-stream").send(stream);
    },
  );
}
