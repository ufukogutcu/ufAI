import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { Cluster, LocationKind } from "./contracts.js";
import type { AgentExecution } from "./agent-execution.js";
import { ManagedFiles } from "./managed-files.js";
import { guard } from "./connections.js";
import { ConnectionError } from "./model-providers.js";
import { InputError, objectBody, pagination } from "./validation.js";

const ts = () => new Date().toISOString();
export function registerLocations(
  app: FastifyInstance,
  db: Database.Database,
  execution: AgentExecution,
  files: ManagedFiles,
) {
  app.addHook("onRequest", async (req) => {
    if (
      /^\/api\/(clusters|locations|deletions)(\/|\?|$)/.test(req.url) ||
      /^\/api\/workspaces\/.+\/(clusters|locations|deletions)/.test(req.url)
    )
      guard(req);
  });
  const workspace = (id: string) => {
    if (!db.prepare("SELECT id FROM workspaces WHERE id=?").get(id))
      throw new ConnectionError("Workspace not found.", 404);
  };
  const cluster = (id: string) => {
    const row = db.prepare("SELECT * FROM clusters WHERE id=?").get(id) as
      | Cluster
      | undefined;
    if (!row) throw new ConnectionError("Cluster not found.", 404);
    return row;
  };
  function validate(body: unknown, old?: Cluster) {
    const p = objectBody(body),
      fields: Record<string, string> = {};
    for (const key of Object.keys(p))
      if (!["name", "description", "x", "y", "width", "height"].includes(key))
        fields[key] = "Unknown field.";
    const v = {
      name: "",
      description: "",
      x: 0,
      y: 0,
      width: 600,
      height: 360,
      ...old,
      ...p,
    };
    if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 120)
      fields.name = "Enter a name from 1 to 120 characters.";
    if (typeof v.description !== "string" || v.description.length > 4000)
      fields.description = "Use at most 4,000 characters.";
    for (const k of ["x", "y", "width", "height"] as const)
      if (
        typeof v[k] !== "number" ||
        !Number.isFinite(v[k]) ||
        Math.abs(v[k] as number) > 1e6
      )
        fields[k] = "Use a finite number within 1,000,000.";
    if (typeof v.width === "number" && v.width < 320)
      fields.width = "Use a width of at least 320.";
    if (typeof v.height === "number" && v.height < 200)
      fields.height = "Use a height of at least 200.";
    if (Object.keys(fields).length) throw new InputError(fields);
    return {
      name: (v.name as string).trim(),
      description: (v.description as string).trim(),
      x: v.x as number,
      y: v.y as number,
      width: v.width as number,
      height: v.height as number,
    };
  }
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/clusters",
    async (req) => {
      workspace(req.params.id);
      const { limit, offset } = pagination(req.query);
      return {
        items: db
          .prepare(
            "SELECT * FROM clusters WHERE workspaceId=? ORDER BY createdAt,id LIMIT ? OFFSET ?",
          )
          .all(req.params.id, limit, offset),
        total: (
          db
            .prepare("SELECT count(*) AS n FROM clusters WHERE workspaceId=?")
            .get(req.params.id) as { n: number }
        ).n,
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/clusters",
    async (req, reply) => {
      workspace(req.params.id);
      files.assertAvailable(req.params.id);
      const v = validate(req.body),
        id = randomUUID(),
        now = ts();
      const counts = db
        .prepare(
          "SELECT colorSlot,count(*) AS n FROM clusters WHERE workspaceId=? GROUP BY colorSlot",
        )
        .all(req.params.id) as { colorSlot: number; n: number }[];
      let colorSlot = 0;
      for (let i = 1; i < 16; i++)
        if (
          (counts.find((c) => c.colorSlot === i)?.n ?? 0) <
          (counts.find((c) => c.colorSlot === colorSlot)?.n ?? 0)
        )
          colorSlot = i;
      db.prepare(
        "INSERT INTO clusters(id,workspaceId,name,description,x,y,width,height,colorSlot,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        req.params.id,
        v.name,
        v.description,
        v.x,
        v.y,
        v.width,
        v.height,
        colorSlot,
        now,
        now,
      );
      files.kick();
      execution.workspaceEvent(req.params.id, "clusters");
      return reply.code(201).send(cluster(id));
    },
  );
  app.get<{ Params: { id: string } }>("/api/clusters/:id", async (req) =>
    cluster(req.params.id),
  );
  app.patch<{ Params: { id: string } }>("/api/clusters/:id", async (req) => {
    const old = cluster(req.params.id);
    files.assertAvailable(old.workspaceId, undefined, old.id);
    const v = validate(req.body, old),
      dx = v.x - old.x,
      dy = v.y - old.y;
    // Existing members keep their relative location when the group moves. Origin (top-left) must remain inside its content area.
    const members = db
      .prepare("SELECT id,x,y FROM agents WHERE clusterId=?")
      .all(old.id) as { id: string; x: number; y: number }[];
    if (
      members.some(
        (a) =>
          a.x + dx + 112 < v.x ||
          a.y + dy + 52 < v.y + 48 ||
          a.x + dx + 112 > v.x + v.width ||
          a.y + dy + 52 > v.y + v.height,
      )
    )
      throw new InputError({
        width:
          "The Cluster must contain its existing members. Move agents inward before shrinking it.",
      });
    if (
      members.some((a) => Math.abs(a.x + dx) > 1e6 || Math.abs(a.y + dy) > 1e6)
    )
      throw new InputError({
        x: "A member would be outside the canvas coordinate limit.",
      });
    members.forEach((a) => files.assertAvailable(old.workspaceId, a.id));
    db.transaction(() => {
      db.prepare(
        "UPDATE clusters SET name=?,description=?,x=?,y=?,width=?,height=?,updatedAt=? WHERE id=?",
      ).run(v.name, v.description, v.x, v.y, v.width, v.height, ts(), old.id);
      if (dx || dy)
        db.prepare(
          "UPDATE agents SET x=x+?,y=y+?,updatedAt=? WHERE clusterId=?",
        ).run(dx, dy, ts(), old.id);
    })();
    execution.workspaceEvent(old.workspaceId, "clusters");
    return cluster(old.id);
  });
  app.delete<{ Params: { id: string } }>(
    "/api/clusters/:id",
    async (req, reply) => {
      const body = req.body as { confirmFilesDeletion?: unknown } | undefined;
      return reply
        .code(202)
        .send(
          files.requestDeletion(
            "cluster",
            req.params.id,
            body?.confirmFilesDeletion,
          ),
        );
    },
  );
  for (const [segment, kind] of [
    ["workspaces", "workspace"],
    ["clusters", "cluster"],
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
      if (!["workspace", "cluster", "agent", "task"].includes(req.params.kind))
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
