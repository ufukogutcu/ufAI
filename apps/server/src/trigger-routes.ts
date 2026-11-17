import type { FastifyInstance } from "fastify";
import { guard } from "./connections.js";
import { objectBody, pagination } from "./validation.js";
import type { Triggers } from "./triggers.js";
import type { TriggerUploads } from "./trigger-uploads.js";
import { text, triggerError, wallTime } from "./trigger-schedule.js";

export function registerTriggers(
  app: FastifyInstance,
  t: Triggers,
  uploads: TriggerUploads,
) {
  app.addHook("onRequest", async (req) => {
    if (
      /^\/api\/(triggers(?:[/?]|$)|event-sources(?:[/?]|$)|skill-automations(?:[/?]|$)|agents\/[^/]+\/(?:triggers|skill-automations)|workspaces\/[^/]+\/(?:triggers|trigger-activity|event-sources|event-receipts))/.test(
        req.url,
      ) &&
      !/^\/api\/event-sources\/[^/?]+\/events(?:\?|$)/.test(req.url)
    )
      guard(req);
  });
  const revision = (v: unknown) => {
    if (!Number.isSafeInteger(v) || Number(v) < 1)
      triggerError("Provide the saved revision.");
    return Number(v);
  };
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/triggers",
    async (req) => {
      const a = t.execution.requiredAgent(req.params.id),
        p = pagination(req.query);
      return t.list(a.workspaceId, a.id, p.limit, p.offset, req.query as any);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/agents/:id/triggers",
    { bodyLimit: 65536 },
    async (req, reply) =>
      reply
        .code(201)
        .send(await t.save(req.params.id, objectBody(req.body).trigger)),
  );
  app.post("/api/triggers/preview", { bodyLimit: 65536 }, async (req) => {
    const b = objectBody(req.body);
    return t.preview(b.when, b.sample);
  });
  app.post("/api/triggers/resolve-time", async (req) => {
    const b = objectBody(req.body);
    return { at: wallTime(String(b.local ?? ""), String(b.timezone ?? "")) };
  });
  app.get<{ Params: { id: string } }>("/api/triggers/:id", async (req) =>
    t.get(req.params.id),
  );
  app.patch<{ Params: { id: string } }>(
    "/api/triggers/:id",
    { bodyLimit: 65536 },
    async (req) => {
      const b = objectBody(req.body),
        old = t.get(req.params.id);
      return t.save(
        old.agentId,
        b.trigger,
        old.id,
        revision(b.expectedRevision),
      );
    },
  );
  app.delete<{ Params: { id: string } }>("/api/triggers/:id", async (req) => {
    const b = objectBody(req.body);
    return t.remove(
      req.params.id,
      revision(b.expectedRevision),
      b.confirmed === true,
    );
  });
  app.post<{ Params: { id: string } }>(
    "/api/triggers/:id/run",
    { bodyLimit: 65536 },
    async (req) => {
      const b = objectBody(req.body);
      return t.run(req.params.id, String(b.requestId ?? ""), b.event);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/triggers/:id/cancel-queued",
    async (req) =>
      t.cancelQueued(req.params.id, objectBody(req.body).confirmed === true),
  );
  app.get<{ Params: { id: string } }>(
    "/api/triggers/:id/occurrences",
    async (req) => {
      const trigger = t.get(req.params.id),
        p = pagination(req.query);
      return t.occurrences(trigger.workspaceId, trigger.id, p.limit, p.offset);
    },
  );
  app.get<{ Params: { id: string }; Querystring: { agentId?: string } }>(
    "/api/workspaces/:id/triggers",
    async (req) => {
      const p = pagination(req.query);
      return t.list(
        req.params.id,
        req.query.agentId || undefined,
        p.limit,
        p.offset,
        req.query as any,
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/trigger-activity",
    async (req) => {
      const p = pagination(req.query);
      return t.occurrences(req.params.id, undefined, p.limit, p.offset);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/event-sources",
    async (req) => {
      const p = pagination(req.query);
      return t.sources(req.params.id, p.limit, p.offset);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/event-sources",
    async (req, reply) =>
      reply.code(201).send(t.saveSource(req.params.id, objectBody(req.body))),
  );
  app.patch<{ Params: { id: string } }>("/api/event-sources/:id", async (req) =>
    t.saveSource(
      t.source(req.params.id).workspaceId,
      objectBody(req.body),
      req.params.id,
    ),
  );
  app.post<{ Params: { id: string } }>(
    "/api/event-sources/:id/rotate",
    async (req) =>
      t.rotateSource(
        req.params.id,
        revision(objectBody(req.body).expectedRevision),
      ),
  );
  app.get<{ Params: { id: string } }>("/api/event-sources/:id", async (req) =>
    t.source(req.params.id),
  );
  app.get<{ Params: { id: string }; Querystring: { sourceId?: string } }>(
    "/api/workspaces/:id/event-receipts",
    async (req) => {
      t.execution.assertWorkspaceAvailable(req.params.id);
      const p = pagination(req.query);
      return t.receipts(req.params.id, req.query.sourceId, p.limit, p.offset);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/event-sources/:id/events",
    { bodyLimit: 65536 },
    async (req, reply) => {
      const source = t.authenticate(req.params.id, req.headers.authorization);
      const receipt = req.isMultipart()
        ? await uploads.receive(req, source.id)
        : t.accept(
            source.workspaceId,
            source.id,
            source.id,
            t.eventInput(req.body),
          );
      return reply.code(202).send(receipt);
    },
  );
  app.get<{ Params: { id: string }; Querystring: { skillId?: string } }>(
    "/api/agents/:id/skill-automations",
    async (req) => {
      const p = pagination(req.query);
      return t.automation!.list(
        req.params.id,
        req.query.skillId,
        p.limit,
        p.offset,
      );
    },
  );
  app.get<{ Params: { id: string; skillId: string } }>(
    "/api/agents/:id/skill-automations/:skillId",
    async (req) => t.automation!.inspect(req.params.id, req.params.skillId),
  );
  app.post<{ Params: { id: string; skillId: string } }>(
    "/api/agents/:id/skill-automations/:skillId/templates",
    { bodyLimit: 65536 },
    async (req, reply) => {
      const b = objectBody(req.body);
      return reply
        .code(201)
        .send(
          await t.automation!.fromTemplate(
            req.params.id,
            req.params.skillId,
            String(b.templateId),
            b.overrides ?? {},
            undefined,
            text(b.fingerprint, "the reviewed package fingerprint", 128),
          ),
        );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/skill-automations/:id/review",
    async (req) => {
      const b = objectBody(req.body);
      return t.automation!.review(
        req.params.id,
        String(b.fingerprint),
        b.state as any,
      );
    },
  );
}
