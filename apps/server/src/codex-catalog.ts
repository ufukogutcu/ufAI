import type { CodexCatalogLauncher } from "./codex-process.js";

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_MODELS = 5000;

function parseContexts(raw: string): Map<string, number> {
  const catalog: unknown = JSON.parse(raw);
  if (
    !catalog || typeof catalog !== "object" || !("models" in catalog) ||
    !Array.isArray(catalog.models) || catalog.models.length > MAX_CATALOG_MODELS
  )
    return new Map();
  const contexts = new Map<string, number>();
  for (const model of catalog.models) {
    if (
      model && typeof model === "object" &&
      typeof model.slug === "string" && model.slug.length <= 200 &&
      Number.isSafeInteger(model.context_window) && model.context_window > 0
    )
      contexts.set(model.slug, model.context_window);
  }
  return contexts;
}

function readCatalog(
  home: string,
  bundled: boolean,
  deadline: number,
  signal: AbortSignal,
  launcher: CodexCatalogLauncher,
  timeoutMs: number,
): Promise<Map<string, number>> {
  const remaining = Math.min(timeoutMs, deadline - Date.now());
  if (signal.aborted || remaining <= 0) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    let proc: ReturnType<CodexCatalogLauncher>;
    try {
      proc = launcher(home, bundled);
    } catch {
      resolve(new Map());
      return;
    }
    let failed = false;
    let size = 0;
    let chunks: Buffer[] = [];
    const stop = () => {
      failed = true;
      chunks = [];
      proc.kill("SIGKILL");
    };
    const timer = setTimeout(stop, remaining);
    const onData = (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_CATALOG_BYTES) stop();
      else chunks.push(chunk);
    };
    proc.stdout.on("data", onData);
    proc.stdout.on("error", stop);
    proc.stdin.on("error", stop);
    proc.stderr.on("error", stop);
    proc.on("error", stop);
    // Catalogs and stderr can contain private account metadata; never log either.
    proc.stderr.resume();
    signal.addEventListener("abort", stop, { once: true });
    proc.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      proc.stdout.removeListener("data", onData);
      let contexts = new Map<string, number>();
      if (!failed && code === 0 && Date.now() < deadline) {
        try {
          contexts = parseContexts(Buffer.concat(chunks, size).toString("utf8"));
        } catch {
          // Optional enrichment must not discard an otherwise valid model list.
        }
      }
      chunks = [];
      resolve(contexts);
    });
    proc.stdin.end();
    if (signal.aborted) stop();
  });
}

export async function readCodexContexts(
  home: string,
  modelIds: string[],
  deadline: number,
  signal: AbortSignal,
  launcher: CodexCatalogLauncher,
  timeoutMs = 3000,
): Promise<Map<string, number>> {
  if (!modelIds.length) return new Map();
  const contexts = await readCatalog(home, false, deadline, signal, launcher, timeoutMs);
  if (modelIds.some((id) => !contexts.has(id))) {
    const bundled = await readCatalog(home, true, deadline, signal, launcher, timeoutMs);
    for (const id of modelIds) {
      const value = bundled.get(id);
      if (!contexts.has(id) && value !== undefined) contexts.set(id, value);
    }
  }
  return contexts;
}
