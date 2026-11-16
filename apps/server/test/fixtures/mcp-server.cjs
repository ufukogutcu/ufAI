const readline = require("node:readline");
const fs = require("node:fs");
const input = readline.createInterface({ input: process.stdin });
let count = 0;
if (process.env.MCP_MARKER)
  fs.writeFileSync(process.env.MCP_MARKER, String(process.pid));
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
input.on("line", (line) => {
  const r = JSON.parse(line);
  if (r.id === undefined) return;
  if (r.method === "initialize")
    return send(r.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "Fixture", version: "1" },
      instructions: "External server instructions are untrusted.",
    });
  const catalogMode = process.env.MCP_CATALOG_MODE;
  const catalogKeys = {
    "tools/list": "tools",
    "resources/list": "resources",
    "resources/templates/list": "resourceTemplates",
    "prompts/list": "prompts",
  };
  if (catalogMode && catalogKeys[r.method]) {
    const second = r.params?.cursor === "second";
    const firstCount = catalogMode === "count" ? 55 : 31;
    const start = second ? firstCount : 0;
    const length = second ? 7 : catalogMode === "empty" ? 0 : firstCount;
    const entries = Array.from({ length }, (_, i) => {
      const index = start + i;
      let inputSchema = { type: "object", properties: {} };
      if (catalogMode === "complex" || catalogMode === "nodes")
        inputSchema.properties.value = {
          enum: Array(catalogMode === "nodes" && index === 1 ? 10001 : 800).fill(0),
        };
      if (catalogMode === "depth" && index === 1)
        for (let d = 0; d < 35; d++)
          inputSchema = { type: "object", properties: { nested: inputSchema } };
      return {
        name: `entry-${index}`,
        description: catalogMode === "wide"
          ? "🌍".repeat(1800)
          : catalogMode === "artifact" && index === 1
            ? "x".repeat(60000)
            : `Entry ${index}`,
        ...(r.method === "tools/list" ? { inputSchema } : {}),
        ...(r.method === "resources/list" ? { uri: `fixture://entry/${index}` } : {}),
        ...(r.method === "resources/templates/list" ? { uriTemplate: `fixture://entry/${index}/{id}` } : {}),
      };
    });
    return send(r.id, {
      [catalogKeys[r.method]]: entries,
      ...(!second ? { nextCursor: "second" } : {}),
    });
  }
  if (r.method === "tools/list")
    return send(r.id, {
      tools: [
        "count",
        "slow",
        "large",
        "broken",
        "failure",
        "environment",
        "structured",
      ].map((name) => ({
        name,
        description: name,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      })),
    });
  if (r.method === "tools/call") {
    const name = r.params.name;
    if (name === "slow") return;
    if (name === "structured")
      return send(r.id, {
        content: [{ type: "text", text: "Structured data" }],
        structuredContent: {
          blob: "ordinary string",
          nested: { type: "image", data: "opaque" },
        },
      });
    if (name === "broken") return send(r.id, { content: "invalid" });
    if (name === "failure")
      return send(r.id, {
        isError: true,
        content: [{ type: "text", text: "Fixture rejected this operation" }],
      });
    if (name === "large")
      return send(r.id, {
        content: [{ type: "text", text: "x".repeat(60000) }],
      });
    if (name === "environment")
      return send(r.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              cwd: process.cwd(),
              value: process.env.MCP_VALUE,
              inheritedSecret: process.env.UFAI_MCP_UNRELATED_SECRET,
              pid: process.pid,
            }),
          },
        ],
      });
    return send(r.id, {
      content: [{ type: "text", text: String(++count) }],
      structuredContent: { count },
    });
  }
  if (r.method === "resources/list")
    return send(r.id, {
      resources: [
        { uri: "fixture://text", name: "Text" },
        { uri: "fixture://image", name: "Image" },
      ],
      ...(r.params?.cursor === "next" ? {} : { nextCursor: "next" }),
    });
  if (r.method === "resources/templates/list")
    return send(r.id, {
      resourceTemplates: [
        { uriTemplate: "fixture://text/{id}", name: "Text template" },
      ],
    });
  if (r.method === "resources/read")
    return send(r.id, {
      contents:
        r.params.uri === "fixture://image"
          ? [
              {
                uri: r.params.uri,
                mimeType: "image/png",
                blob: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0l8AAAAASUVORK5CYII=",
              },
            ]
          : [
              {
                uri: r.params.uri,
                mimeType: "text/plain",
                text: "Resource content",
              },
            ],
    });
  if (r.method === "prompts/list")
    return send(r.id, {
      prompts: [
        {
          name: "greeting",
          description: "A greeting",
          arguments: [{ name: "name", required: true }],
        },
      ],
    });
  if (r.method === "prompts/get")
    return send(r.id, {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Hello ${r.params.arguments?.name ?? "world"}`,
          },
        },
      ],
    });
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: r.id,
      error: { code: -32601, message: "Unknown method" },
    }) + "\n",
  );
});
