import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { openDatabase } from "./database.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const app = Fastify({ logger: true });
const database = openDatabase();

app.addHook("onClose", async () => {
  database.close();
});

app.get("/api/health", async () => ({ status: "ok" }));

const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
if (existsSync(webRoot)) {
  app.register(fastifyStatic, { root: webRoot });
}

async function shutdown() {
  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
