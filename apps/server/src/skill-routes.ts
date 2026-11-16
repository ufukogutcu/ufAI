import type { FastifyInstance, FastifyRequest } from "fastify";
import { guard } from "./connections.js";
import { objectBody, pagination } from "./validation.js";
import { badSkill, skillLimits } from "./skill-packages.js";
import type { Skills } from "./skills.js";
import type { SkillInput } from "./skill-types.js";

function body(request: FastifyRequest, fields: string[]) {
  const value = objectBody(request.body);
  if (Object.keys(value).some((key) => !fields.includes(key)))
    badSkill("Unknown skill request field.");
  return value;
}
function string(
  value: unknown,
  label: string,
  optional = false,
): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 4096)
    badSkill(`Provide ${label}.`);
  return value as string;
}
function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    badSkill("Provide the saved skill revision.");
  return value as number;
}
export function registerSkills(app: FastifyInstance, skills: Skills) {
  app.addHook("onRequest", async (request) => {
    if (
      /^\/api\/(skills(?:\/|\?|$)|agents\/[^/]+\/skills(?:\/|\?|$))/.test(
        request.url,
      )
    )
      guard(request);
  });
  function filters(request: FastifyRequest) {
    const query = request.query as Record<string, unknown>;
    const page = pagination(query);
    if (
      query.status !== undefined &&
      !["all", "enabled", "disabled"].includes(String(query.status))
    )
      badSkill("Invalid skill status filter.");
    if (
      query.origin !== undefined &&
      !["all", "builtin", "custom"].includes(String(query.origin))
    )
      badSkill("Invalid skill origin filter.");
    return {
      ...page,
      query:
        typeof query.query === "string"
          ? query.query.slice(0, 1024)
          : undefined,
      status: query.status as string | undefined,
      origin: query.origin as string | undefined,
    };
  }
  app.get("/api/skills", async (request) =>
    skills.list(undefined, filters(request)),
  );
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/skills",
    async (request) => skills.list(request.params.id, filters(request)),
  );
  app.post("/api/skills/refresh", async () => {
    await skills.refresh();
    return { refreshed: true };
  });
  app.post("/api/skills/open-folder", async () => {
    await skills.openFolder();
    return { opened: true };
  });
  app.post("/api/skills", { bodyLimit: 65536 }, async (request, reply) => {
    const value = body(request, ["agentId", "skill"]);
    return reply
      .code(201)
      .send(
        await skills.create(
          string(value.agentId, "the installing agent")!,
          value.skill as SkillInput,
        ),
      );
  });
  app.get<{ Params: { id: string }; Querystring: { agentId?: string } }>(
    "/api/skills/:id",
    async (request) => {
      await skills.refresh(request.params.id);
      return skills.detail(
        request.params.id,
        string(request.query.agentId, "agent ID", true),
      );
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/skills/:id",
    { bodyLimit: 65536 },
    async (request) => {
      const value = body(request, ["agentId", "expectedRevision", "skill"]);
      await skills.refresh(request.params.id);
      return skills.update(
        request.params.id,
        revision(value.expectedRevision),
        value.skill as SkillInput,
        string(value.agentId, "agent ID", true),
      );
    },
  );
  app.delete<{ Params: { id: string } }>("/api/skills/:id", async (request) => {
    const value = body(request, ["expectedRevision", "confirmed"]);
    return skills.remove(
      request.params.id,
      revision(value.expectedRevision),
      value.confirmed === true,
    );
  });
  app.post<{ Params: { id: string } }>(
    "/api/skills/:id/open-folder",
    async (request) => {
      await skills.openFolder(request.params.id);
      return { opened: true };
    },
  );
  app.put<{ Params: { id: string; skillId: string } }>(
    "/api/agents/:id/skills/:skillId",
    async (request) => {
      const value = body(request, ["enabled"]);
      return skills.setEnabled(
        request.params.id,
        request.params.skillId,
        value.enabled as boolean,
      );
    },
  );
  app.post("/api/skills/installations", async (request, reply) => {
    const controller = new AbortController();
    const disconnected = () => {
      if (!request.raw.complete) controller.abort();
    };
    const responseClosed = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    request.raw.once("close", disconnected);
    reply.raw.once("close", responseClosed);
    try {
      if (request.isMultipart()) {
        let agentId: string | undefined,
          upload: Buffer | undefined,
          filename: string | undefined;
        for await (const part of request.parts({
          limits: {
            files: 1,
            fields: 1,
            parts: 2,
            fileSize: skillLimits.download,
            fieldSize: 200,
          },
        })) {
          if (part.type === "field" && part.fieldname === "agentId")
            agentId = string(part.value, "the installing agent");
          else if (part.type === "file" && part.fieldname === "file") {
            filename = part.filename;
            upload = await part.toBuffer();
          } else badSkill("Upload one file and the installing agent ID.");
        }
        if (!upload) badSkill("Choose a SKILL.md or ZIP package.");
        return reply
          .code(201)
          .send(
            await skills.prepare(
              string(agentId, "the installing agent")!,
              { upload, filename },
              controller.signal,
            ),
          );
      }
      const value = body(request, ["agentId", "url"]);
      return reply
        .code(201)
        .send(
          await skills.prepare(
            string(value.agentId, "the installing agent")!,
            { url: string(value.url, "a public skill URL")! },
            controller.signal,
          ),
        );
    } finally {
      request.raw.removeListener("close", disconnected);
      reply.raw.removeListener("close", responseClosed);
    }
  });
  app.post<{ Params: { id: string } }>(
    "/api/skills/installations/:id/commit",
    async (request, reply) => {
      const controller = new AbortController();
      const closed = () => {
        if (!reply.raw.writableFinished) controller.abort();
      };
      reply.raw.once("close", closed);
      try {
        const value = body(request, [
          "agentId",
          "candidateKey",
          "replaceId",
          "expectedRevision",
        ]);
        return await skills.commit(
          string(value.agentId, "the installing agent")!,
          request.params.id,
          string(value.candidateKey, "a skill candidate")!,
          string(value.replaceId, "replacement skill ID", true),
          value.expectedRevision === undefined
            ? undefined
            : revision(value.expectedRevision),
          controller.signal,
        );
      } finally {
        reply.raw.removeListener("close", closed);
      }
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/skills/installations/:id",
    async (request) => {
      const value = body(request, ["agentId"]);
      await skills.discard(
        request.params.id,
        string(value.agentId, "the installing agent")!,
      );
      return { discarded: true };
    },
  );
}
