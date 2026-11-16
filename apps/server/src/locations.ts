import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { LocationKind } from "./contracts.js";
import { ManagedFiles } from "./managed-files.js";
import { guard } from "./connections.js";
import { ConnectionError } from "./model-providers.js";
import { pagination } from "./validation.js";

export function registerLocations(
  app: FastifyInstance,
  db: Database.Database,
  files: ManagedFiles,
) {
  app.addHook("onRequest", async (req) => {
    if (
      /^\/api\/(locations|deletions)(\/|\?|$)/.test(req.url) ||
      /^\/api\/workspaces\/.+\/(locations|deletions)/.test(req.url)
    )
      guard(req);
  });
  const workspace = (id: string) => {
    if (!db.prepare("SELECT id FROM workspaces WHERE id=?").get(id))
      throw new ConnectionError("Workspace not found.", 404);
  };
  for (const [segment, kind] of [
    ["workspaces", "workspace"],
    ["agents", "agent"],
    ["tasks", "task"],
  ] as const) {
    app.get<{ Params: { id: string } }>(
      `/api/${segment}/:id/locations`,
      async (req) => files.location(kind, req.params.id),
    );
  }
  app.post<{ Params: { kind: string; id: string } }>(
    "/api/locations/:kind/:id/repair",
    async (req) => {
      if (!["workspace", "agent", "task"].includes(req.params.kind))
        throw new ConnectionError("Location kind not found.", 404);
      return files.repair(req.params.kind as LocationKind, req.params.id);
    },
  );
  app.get<{ Params: { id: string } }>("/api/deletions/:id", async (req) =>
    files.deletion(req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/deletions/:id/retry",
    async (req, reply) =>
      reply.code(202).send(files.retryDeletion(req.params.id)),
  );
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/deletions",
    async (req) => {
      workspace(req.params.id);
      const { limit, offset } = pagination(req.query);
      const where = "workspaceId=? AND state!='completed'";
      return {
        items: db
          .prepare(
            `SELECT id FROM deletion_operations WHERE ${where} ORDER BY createdAt,id LIMIT ? OFFSET ?`,
          )
          .all(req.params.id, limit, offset)
          .map((r) => files.deletion((r as { id: string }).id)),
        total: (
          db
            .prepare(
              `SELECT count(*) AS n FROM deletion_operations WHERE ${where}`,
            )
            .get(req.params.id) as { n: number }
        ).n,
      };
    },
  );
}
