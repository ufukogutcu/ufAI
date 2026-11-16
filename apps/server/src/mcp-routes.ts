import type { FastifyInstance, FastifyRequest } from "fastify";
import { guard } from "./connections.js";
import { pagination } from "./validation.js";
import { badMcp, mcpObject, mcpRevision, mcpText } from "./mcp-config.js";
import type { McpService } from "./mcp-service.js";
import type { McpCapabilityKind } from "./mcp-types.js";
function body(req: FastifyRequest, fields: string[]) {
  const value = mcpObject(req.body);
  if (Object.keys(value).some((k) => !fields.includes(k)))
    badMcp("Unknown MCP request field.");
  return value;
}
export function mcpRedirectUrl(app: FastifyInstance) {
  const address = app.server.address();
  const port =
    typeof address === "object" && address
      ? address.port
      : Number(process.env.PORT ?? 3000);
  return `http://127.0.0.1:${port}/api/mcp/oauth/callback`;
}
export function registerMcp(app: FastifyInstance, service: McpService) {
  app.addHook("onRequest", async (req, reply) => {
    if (
      /^\/api\/(mcp(?:\/|\?|$)|agents\/[^/]+\/mcp(?:\/|\?|$))/.test(req.url)
    ) {
      reply.header("Cache-Control", "no-store");
      if (req.url.split("?")[0] !== "/api/mcp/oauth/callback") guard(req);
    }
  });
  app.get("/api/mcp/servers", async (req) => {
    const q = req.query as Record<string, unknown>,
      p = pagination(q);
    return service.list(
      q.agentId === undefined
        ? undefined
        : mcpText(q.agentId, "an agent ID", 100),
      typeof q.query === "string" ? q.query.slice(0, 1024) : "",
      p.offset,
      p.limit,
    );
  });
  app.get<{ Params: { id: string }; Querystring: { agentId?: string } }>(
    "/api/mcp/servers/:id",
    async (req) => service.detail(req.params.id, req.query.agentId),
  );
  app.post("/api/mcp/servers", { bodyLimit: 131072 }, async (req, reply) => {
    const b = body(req, ["agentId", "server"]);
    return reply
      .code(201)
      .send(
        await service.create(mcpText(b.agentId, "an agent ID", 100), b.server),
      );
  });
  app.patch<{ Params: { id: string } }>(
    "/api/mcp/servers/:id",
    { bodyLimit: 131072 },
    async (req) => {
      const b = body(req, ["agentId", "expectedRevision", "server"]);
      return service.update(
        req.params.id,
        mcpText(b.agentId, "an agent ID", 100),
        mcpRevision(b.expectedRevision),
        b.server,
      );
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/mcp/servers/:id",
    async (req) => {
      const b = body(req, ["expectedRevision", "confirmed"]);
      if (b.confirmed !== true) badMcp("Confirm shared MCP server removal.");
      return service.remove(req.params.id, mcpRevision(b.expectedRevision));
    },
  );
  app.put<{ Params: { id: string; serverId: string } }>(
    "/api/agents/:id/mcp/servers/:serverId",
    async (req) => {
      const b = body(req, ["enabled"]);
      if (typeof b.enabled !== "boolean")
        badMcp("Provide enabled as a boolean.");
      return service.setEnabled(req.params.id, req.params.serverId, b.enabled);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/mcp/servers/:id/connect",
    async (req) => {
      const b = body(req, ["agentId"]);
      return service.connect(
        req.params.id,
        mcpText(b.agentId, "an agent ID", 100),
        mcpRedirectUrl(app),
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/mcp/servers/:id/disconnect",
    async (req) => {
      const b = body(req, ["agentId"]);
      return service.disconnect(
        req.params.id,
        mcpText(b.agentId, "an agent ID", 100),
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/mcp/servers/:id/capabilities",
    async (req, reply) => {
      const q = req.query as Record<string, unknown>,
        p = pagination(q);
      if (
        !["tools", "resources", "templates", "prompts"].includes(String(q.kind))
      )
        badMcp("Choose tools, resources, templates or prompts.");
      const controller = new AbortController();
      const close = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.on("close", close);
      try {
        return await service.capabilities(
          req.params.id,
          mcpText(q.agentId, "an agent ID", 100),
          q.kind as McpCapabilityKind,
          q.cursor === undefined
            ? undefined
            : mcpText(q.cursor, "a capability cursor", 16384),
          p.limit,
          mcpRedirectUrl(app),
          controller.signal,
        );
      } finally {
        reply.raw.off("close", close);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/mcp/servers/:id/oauth/sign-in",
    async (req) => {
      const b = body(req, ["agentId"]);
      return service.signIn(
        req.params.id,
        mcpText(b.agentId, "an agent ID", 100),
        mcpRedirectUrl(app),
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/mcp/servers/:id/oauth/sign-out",
    async (req) => {
      const b = body(req, ["expectedRevision"]);
      return service.signOut(req.params.id, mcpRevision(b.expectedRevision));
    },
  );
  app.get(
    "/api/mcp/oauth/callback",
    { logLevel: "silent" },
    async (req, reply) => {
      // OAuth arrives cross-site, so validate the loopback host and one-use state instead.
      let hostname = "";
      try {
        hostname = new URL(`http://${req.headers.host}`).hostname;
      } catch {}
      if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname))
        badMcp("MCP sign-in requires the local callback host.", 403);
      reply
        .header(
          "Content-Security-Policy",
          "default-src 'none'; frame-ancestors 'none'",
        )
        .header("Referrer-Policy", "no-referrer");
      await service.callback(new URL(req.url, "http://127.0.0.1").searchParams);
      return reply
        .type("text/plain; charset=utf-8")
        .send("MCP sign-in completed. Return to ufAI and connect the server.");
    },
  );
  app.post("/api/mcp/imports", { bodyLimit: 1048576 }, async (req, reply) => {
    const b = body(req, ["agentId", "config"]);
    let config = b.config;
    if (typeof config === "string") {
      try {
        config = JSON.parse(config);
      } catch {
        badMcp("Import must contain valid JSON.");
      }
    }
    return reply
      .code(201)
      .send(service.preview(mcpText(b.agentId, "an agent ID", 100), config));
  });
  app.post<{ Params: { id: string } }>(
    "/api/mcp/imports/:id/commit",
    async (req) => {
      const b = body(req, [
        "agentId",
        "candidateKey",
        "replaceId",
        "expectedRevision",
      ]);
      return service.commitPreview(
        req.params.id,
        mcpText(b.agentId, "an agent ID", 100),
        mcpText(b.candidateKey, "an import candidate", 100),
        b.replaceId === undefined
          ? undefined
          : mcpText(b.replaceId, "a replacement ID", 100),
        b.expectedRevision === undefined
          ? undefined
          : mcpRevision(b.expectedRevision),
      );
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/mcp/imports/:id",
    async (req) => {
      const b = body(req, ["agentId"]);
      return service.discardPreview(
        req.params.id,
        mcpText(b.agentId, "an agent ID", 100),
      );
    },
  );
}
