import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { ManagedFiles } from "./managed-files.js";
import { AgentExecution } from "./agent-execution.js";
import { guard } from "./connections.js";
import { ConnectionError } from "./model-providers.js";
import { objectBody, InputError, pagination } from "./validation.js";

const time = () => new Date().toISOString();
const invalid = (field: string, message: string): never => {
  throw new InputError({ [field]: message });
};
function fields(body: unknown, allowed: string[]) {
  const patch = objectBody(body);
  for (const key of Object.keys(patch))
    if (!allowed.includes(key)) invalid(key, "Unknown field.");
  return patch;
}
function content(value: unknown, key = "content", max = 12000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    return invalid(
      key,
      `Enter between 1 and ${max.toLocaleString("en-US")} characters.`,
    );
  return value.trim();
}
function input(body: unknown) {
  const p = fields(body, ["content", "requestId"]);
  const requestId = content(p.requestId, "requestId", 100);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId))
    invalid(
      "requestId",
      "Use a unique request ID of 8–100 letters, numbers, underscores or hyphens.",
    );
  return { content: content(p.content), requestId };
}
export function registerAgents(
  app: FastifyInstance,
  db: Database.Database,
  execution: AgentExecution,
  files: ManagedFiles,
  incoming?: import("./submission-media.js").SubmissionMedia,
) {
  app.addHook("onRequest", async (request) => {
    if (
      /^\/api\/(agents|tasks|events)(\/|\?|$)/.test(request.url) ||
      /^\/api\/workspaces\/.+\/agents/.test(request.url) ||
      (request.method === "DELETE" &&
        request.url.startsWith("/api/workspaces/"))
    )
      guard(request);
  });
  const workspace = (id: string) => {
    execution.assertWorkspaceAvailable(id);
    if (!db.prepare("SELECT id FROM workspaces WHERE id=?").get(id))
      throw new ConnectionError("Workspace not found.", 404);
  };
  const validate = (body: unknown, existing?: any) => {
    const p = fields(body, [
      "name",
      "instructions",
      "presetId",
      "x",
      "y",
      "clusterId",
    ]);
    const v = {
      name: "",
      instructions: "",
      presetId: null,
      clusterId: null,
      x: 0,
      y: 0,
      ...existing,
      ...p,
    };
    v.name = content(v.name, "name", 120);
    if (typeof v.instructions !== "string" || v.instructions.length > 8000)
      invalid("instructions", "Use at most 8,000 characters.");
    if (
      v.presetId !== null &&
      (typeof v.presetId !== "string" ||
        !db.prepare("SELECT id FROM model_presets WHERE id=?").get(v.presetId))
    )
      invalid("presetId", "Choose an existing preset, or none.");
    for (const key of ["x", "y"])
      if (
        typeof v[key] !== "number" ||
        !Number.isFinite(v[key]) ||
        Math.abs(v[key]) > 1e6
      )
        invalid(
          key,
          "Use a finite coordinate between -1,000,000 and 1,000,000.",
        );
    return v;
  };
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/agents",
    async (req) => {
      workspace(req.params.id);
      const { limit, offset } = pagination(req.query);
      const rows = db
        .prepare(
          "SELECT id FROM agents WHERE workspaceId=? ORDER BY createdAt,id LIMIT ? OFFSET ?",
        )
        .all(req.params.id, limit, offset) as { id: string }[];
      return {
        items: rows.map((r) => execution.requiredAgent(r.id, true)),
        total: (
          db
            .prepare("SELECT count(*) AS n FROM agents WHERE workspaceId=?")
            .get(req.params.id) as any
        ).n,
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/agents",
    async (req, reply) => {
      workspace(req.params.id);
      const v = validate(req.body);
      if (v.clusterId !== null) {
        if (typeof v.clusterId !== "string")
          invalid("clusterId", "Choose a Cluster in this workspace.");
        const c = db
          .prepare("SELECT * FROM clusters WHERE id=?")
          .get(v.clusterId) as
          | {
              workspaceId: string;
              x: number;
              y: number;
              width: number;
              height: number;
            }
          | undefined;
        if (!c || c.workspaceId !== req.params.id)
          invalid("clusterId", "Choose a Cluster in this workspace.");
        if (
          c &&
          (v.x + 112 < c.x ||
            v.x + 112 > c.x + c.width ||
            v.y + 52 < c.y + 48 ||
            v.y + 52 > c.y + c.height)
        )
          invalid(
            "clusterId",
            "Place the agent inside the Cluster content area.",
          );
        files.assertAvailable(req.params.id, undefined, v.clusterId);
      }
      const id = randomUUID(),
        ts = time();
      db.prepare(
        "INSERT INTO agents(id,workspaceId,name,instructions,presetId,x,y,clusterId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        req.params.id,
        v.name,
        v.instructions,
        v.presetId,
        v.x,
        v.y,
        v.clusterId,
        ts,
        ts,
      );
      execution.event(id);
      files.kick();
      return reply.code(201).send(execution.requiredAgent(id));
    },
  );
  app.get<{ Params: { id: string } }>("/api/agents/:id", async (req) =>
    execution.requiredAgent(req.params.id, true),
  );
  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (req) => {
    const old = execution.requiredAgent(req.params.id);
    const v = validate(req.body, old);
    if (v.clusterId !== null) {
      if (typeof v.clusterId !== "string")
        invalid("clusterId", "Choose a Cluster in this workspace.");
      const c = db
        .prepare("SELECT * FROM clusters WHERE id=?")
        .get(v.clusterId) as
        | {
            workspaceId: string;
            x: number;
            y: number;
            width: number;
            height: number;
          }
        | undefined;
      if (!c || c.workspaceId !== old.workspaceId)
        invalid("clusterId", "Choose a Cluster in this workspace.");
      if (
        c &&
        (v.x + 112 < c.x ||
          v.x + 112 > c.x + c.width ||
          v.y + 52 < c.y + 48 ||
          v.y + 52 > c.y + c.height)
      )
        invalid("clusterId", "Drop the agent inside the Cluster content area.");
    }
    files.assertAvailable(old.workspaceId, old.id, old.clusterId);
    files.assertAvailable(old.workspaceId, old.id, v.clusterId);
    db.prepare(
      "UPDATE agents SET name=?,instructions=?,presetId=?,x=?,y=?,clusterId=?,revision=revision+?,updatedAt=? WHERE id=?",
    ).run(
      v.name,
      v.instructions,
      v.presetId,
      v.x,
      v.y,
      v.clusterId,
      Number(
        v.name !== old.name ||
          v.instructions !== old.instructions ||
          v.presetId !== old.presetId,
      ),
      time(),
      old.id,
    );
    execution.event(old.id);
    return execution.requiredAgent(old.id);
  });
  app.delete<{ Params: { id: string } }>(
    "/api/agents/:id",
    async (req, reply) => {
      const body = req.body as { confirmFilesDeletion?: unknown } | undefined;
      return reply
        .code(202)
        .send(
          files.requestDeletion(
            "agent",
            req.params.id,
            body?.confirmFilesDeletion,
          ),
        );
    },
  );
  app.get<{ Params: { id: string } }>("/api/agents/:id/tasks", async (req) => {
    execution.requiredAgent(req.params.id);
    const { limit, offset } = pagination(req.query);
    return {
      items: db
        .prepare(
          "SELECT * FROM agent_tasks WHERE agentId=? ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?",
        )
        .all(req.params.id, limit, offset),
      total: (
        db
          .prepare("SELECT count(*) AS n FROM agent_tasks WHERE agentId=?")
          .get(req.params.id) as any
      ).n,
    };
  });
  app.post<{ Params: { id: string } }>(
    "/api/agents/:id/tasks",
    async (req, reply) => {
      if (req.isMultipart() && incoming)
        return reply
          .code(202)
          .send(await incoming.receive(req, req.params.id, "new"));
      const v = input(req.body);
      return reply
        .code(202)
        .send(execution.submit(req.params.id, "new", v.content, v.requestId));
    },
  );
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req) => {
    const task = execution.task(req.params.id);
    return {
      task,
      turns: db
        .prepare(
          "SELECT * FROM agent_turns WHERE taskId=? ORDER BY updatedAt DESC,rowid DESC LIMIT 100",
        )
        .all(task.id),
    };
  });
  const messages = (conversationId: string, query: unknown) => {
    const q = query as { before?: string; limit?: string };
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    const before =
      q.before === undefined ? Number.MAX_SAFE_INTEGER : Number(q.before);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(before) ||
      before < 1
    )
      invalid(
        "before",
        "Use a positive message cursor and a limit from 1 to 100.",
      );
    return {
      items: db
        .prepare(
          "SELECT * FROM agent_messages WHERE conversationId=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
        )
        .all(conversationId, before, limit)
        .reverse()
        .map((m: any) => ({
          ...m,
          parts: [
            { type: "text", text: m.content },
            ...(
              db
                .prepare(
                  "SELECT r.versionId,r.mode,v.name FROM artifact_references r JOIN artifact_versions v ON v.id=r.versionId WHERE r.messageId=? ORDER BY r.ordinal",
                )
                .all(m.id) as { versionId: string; name: string }[]
            ).map((v) => ({ type: "artifact", ...v })),
          ],
        })),
      total: (
        db
          .prepare(
            "SELECT count(*) AS n FROM agent_messages WHERE conversationId=?",
          )
          .get(conversationId) as any
      ).n,
    };
  };
  app.get<{ Params: { id: string } }>("/api/tasks/:id/messages", async (req) =>
    messages(execution.task(req.params.id).conversationId, req.query),
  );
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/messages",
    async (req, reply) => {
      const task = execution.task(req.params.id);
      if (req.isMultipart() && incoming)
        return reply
          .code(202)
          .send(await incoming.receive(req, task.agentId, task.id));
      const v = input(req.body);
      return reply
        .code(202)
        .send(execution.submit(task.agentId, task.id, v.content, v.requestId));
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/cancel",
    async (req, reply) => {
      await execution.cancelTask(req.params.id);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/retry",
    async (req, reply) => reply.code(202).send(execution.retry(req.params.id)),
  );
  app.get<{ Params: { id: string } }>("/api/agents/:id/status", async (req) =>
    execution.workload(req.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/status/messages",
    async (req) => {
      execution.requiredAgent(req.params.id);
      return messages(
        execution.conversation(req.params.id, "status"),
        req.query,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/agents/:id/status/messages",
    async (req, reply) => {
      const v = input(req.body);
      return reply
        .code(202)
        .send(
          execution.submit(req.params.id, "status", v.content, v.requestId),
        );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/memories",
    async (req) => {
      execution.requiredAgent(req.params.id);
      const { limit, offset } = pagination(req.query);
      return {
        items: execution.memories(req.params.id, limit, offset),
        total: (
          db
            .prepare(
              "SELECT count(*) AS n FROM agent_memories WHERE agentId=? AND deleted=0",
            )
            .get(req.params.id) as any
        ).n,
      };
    },
  );
  const memory = (agentId: string, id: string) => {
    execution.requiredAgent(agentId);
    const m = db
      .prepare(
        "SELECT * FROM agent_memories WHERE agentId=? AND id=? AND deleted=0",
      )
      .get(agentId, id) as any;
    if (!m) throw new ConnectionError("Memory not found.", 404);
    return m;
  };
  app.patch<{ Params: { id: string; memoryId: string } }>(
    "/api/agents/:id/memories/:memoryId",
    async (req) => {
      const m = memory(req.params.id, req.params.memoryId),
        p = fields(req.body, ["content", "revision"]);
      if (p.revision !== m.revision)
        throw new ConnectionError(
          "Memory changed. Refresh it before saving.",
          409,
        );
      const value = content(p.content, "content", 1200);
      db.prepare(
        "UPDATE agent_memories SET content=?,revision=revision+1,updatedAt=? WHERE id=?",
      ).run(value, time(), m.id);
      execution.event(m.agentId);
      const updated = memory(m.agentId, m.id);
      return { ...updated, sources: JSON.parse(updated.sources) };
    },
  );
  app.delete<{ Params: { id: string; memoryId: string } }>(
    "/api/agents/:id/memories/:memoryId",
    async (req, reply) => {
      const m = memory(req.params.id, req.params.memoryId);
      db.prepare(
        "UPDATE agent_memories SET deleted=1,revision=revision+1,updatedAt=? WHERE id=?",
      ).run(time(), m.id);
      execution.event(m.agentId);
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { id: string; sourceId: string } }>(
    "/api/agents/:id/sources/:sourceId",
    async (req) => {
      execution.requiredAgent(req.params.id);
      const row = db
        .prepare(
          `SELECT m.*, t.id AS taskId FROM agent_messages m JOIN agent_tasks t ON t.conversationId=m.conversationId WHERE m.id=? AND t.agentId=?`,
        )
        .get(req.params.sourceId, req.params.id) as any;
      if (!row) throw new ConnectionError("Source not found.", 404);
      const { taskId, ...message } = row;
      return { taskId, message };
    },
  );
  app.get("/api/events", async (req, reply) => {
    const q = req.query as { workspaceId?: string; after?: string };
    if (!q.workspaceId) invalid("workspaceId", "Choose a workspace.");
    workspace(q.workspaceId!);
    let cursor = Number(req.headers["last-event-id"] ?? q.after ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      invalid("after", "Use a non-negative event cursor.");
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false,
      scheduled = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      execution.events.off("change", changed);
      execution.events.off("close", stop);
      reply.raw.off("close", cleanup);
    };
    const stop = () => {
      cleanup();
      reply.raw.end();
    };
    const write = (kind: string, sequence: number, data: unknown) => {
      if (closed) return false;
      const ok = reply.raw.write(
        `id: ${sequence}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`,
      );
      if (!ok) stop();
      return ok;
    };
    const pump = () => {
      scheduled = false;
      if (closed) return;
      const bounds = db
        .prepare(
          "SELECT min(sequence) AS oldest,max(sequence) AS latest FROM execution_events",
        )
        .get() as any;
      if (
        !cursor ||
        cursor < (bounds.oldest ?? 0) - 1 ||
        cursor > (bounds.latest ?? 0)
      ) {
        cursor = bounds.latest ?? 0;
        write("resync", cursor, {});
        return;
      }
      const rows = db
        .prepare(
          "SELECT sequence,agentId,kind FROM execution_events WHERE workspaceId=? AND sequence>? ORDER BY sequence LIMIT 100",
        )
        .all(q.workspaceId!, cursor) as any[];
      for (const row of rows) {
        cursor = row.sequence;
        if (!write("change", cursor, row)) break;
      }
      if (rows.length === 100 && !closed) {
        scheduled = true;
        setImmediate(pump);
      }
    };
    const changed = (id: string) => {
      if (id === q.workspaceId && !scheduled && !closed) {
        scheduled = true;
        setImmediate(pump);
      }
    };
    const heartbeat = setInterval(() => {
      if (!closed && !reply.raw.write(": heartbeat\n\n")) stop();
    }, 15000);
    heartbeat.unref();
    execution.events.on("change", changed);
    execution.events.on("close", stop);
    reply.raw.on("close", cleanup);
    pump();
  });
  app.addHook("preClose", async () => {
    execution.events.emit("close");
  });
}
