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
