import { anthropicOutputMaximum } from "./provider-output.js";
import { effectiveMedia } from "./media-service.js";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type Database from "better-sqlite3";
import type { ConnectionProvider } from "./contracts.js";
import type {
  ExecutionSnapshot,
  TextRequest,
  TextResult,
  TaskRequest,
  ToolRound,
} from "./execution-types.js";
import { ConnectionSecrets } from "./connection-secrets.js";
import { CodexRuntime, type CodexAdapter } from "./codex-runtime.js";
import { ProviderModels } from "./provider-models.js";
import { ConnectionError, providerEndpoints } from "./model-providers.js";
import { ToolProvider } from "./tool-provider.js";
import { TextProvider } from "./text-provider.js";

type Connection = {
  id: string;
  provider: ConnectionProvider;
  endpoint: string | null;
  credential: string | null;
  draft: number;
};
export class ConnectionService {
  readonly memory: boolean;
  readonly directory: string;
  readonly secrets: ConnectionSecrets;
  readonly codex: CodexAdapter;
  readonly models: ProviderModels;
  private pins = new Map<string, number>();
  pin(id: string) {
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.pins.get(id) ?? 1) - 1;
      if (n) this.pins.set(id, n);
      else this.pins.delete(id);
    };
  }
  private operations = new Map<string, Map<symbol, "work" | "chat" | "exclusive">>();
  constructor(
    private db: Database.Database,
    private fetcher: typeof fetch = fetch,
    codex?: CodexAdapter,
  ) {
    this.memory = db.name === ":memory:" || !db.name;
    this.directory = this.memory
      ? join(tmpdir(), `ufai-connections-${randomUUID()}`)
      : `${db.name}.connections`;
    this.secrets = new ConnectionSecrets(this.memory ? null : this.directory);
    this.codex = codex ?? new CodexRuntime(join(this.directory, "codex"));
    this.models = new ProviderModels(db);
  }
  busy(id: string) {
    return !!this.operations.get(id)?.size || !!this.pins.get(id);
  }
  claim(id: string, lane: "work" | "chat" | "exclusive") {
    const active = this.operations.get(id) ??
      new Map<symbol, "work" | "chat" | "exclusive">();
    if (
      [...active.values()].includes("exclusive") ||
      (lane === "exclusive" && (active.size || this.pins.get(id)))
    )
      throw new ConnectionError(
        "This Provider is busy. Retry when its current work finishes.",
        409,
      );
    const reservation = Symbol(lane);
    active.set(reservation, lane);
    this.operations.set(id, active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active.delete(reservation);
      if (!active.size) this.operations.delete(id);
    };
  }
  snapshot(agent: {
    presetId: string | null;
    instructions: string;
    revision: number;
  }): ExecutionSnapshot {
    const p = agent.presetId
      ? (this.db
          .prepare("SELECT * FROM model_presets WHERE id = ?")
          .get(agent.presetId) as any)
      : undefined;
    if (!p?.connectionId || !p.modelId)
      throw new ConnectionError(
        "Choose a complete Agent Preset in Configuration, then retry.",
        409,
      );
    const c = this.connection(p.connectionId);
    const model = this.models.get(c.id, p.modelId);
    if (c.draft || !model?.enabled)
      throw new ConnectionError(
        "The selected model is disabled or missing. Repair the Agent Preset, then retry.",
        409,
      );
    if (!model.contextWindow)
      throw new ConnectionError(
        "Set this model’s context window in Providers, then retry.",
        409,
      );
    if (model.contextWindow < 1024)
      throw new ConnectionError(
        "Execution requires a context window of at least 1,024 tokens.",
        409,
      );
    return {
      mediaCapabilities: effectiveMedia(c.provider, model),
      presetId: p.id,
      connectionId: c.id,
      provider: c.provider,
      modelId: p.modelId,
      contextWindow: model.contextWindow,
      compaction:
        p.compactionMode && p.compactionValue
          ? { mode: p.compactionMode, value: p.compactionValue }
          : null,
      instructions: agent.instructions,
      agentRevision: agent.revision,
    };
  }
  private connection(id: string): Connection {
    const c = this.db
      .prepare("SELECT * FROM connections WHERE id = ?")
      .get(id) as Connection | undefined;
    if (!c || c.draft)
      throw new ConnectionError(
        "The Provider was removed or is incomplete. Repair the Agent Preset.",
        409,
      );
    if (
      c.provider !== "codex" &&
      !["ollama", "openai-compatible"].includes(c.provider) &&
      !c.credential
    )
      throw new ConnectionError("Provider credentials are missing.", 401);
    return c;
  }
  private async outputMaximum(
    c: Connection,
    key: string | null,
    request: TextRequest,
  ) {
    const revision = createHash("sha256")
      .update(JSON.stringify([c.endpoint, c.credential])).digest("hex");
    const cached = this.db.prepare(
      "SELECT maxOutputTokens FROM provider_output_metadata WHERE connectionId=? AND modelId=? AND revision=?",
    )
      .get(c.id, request.modelId, revision) as { maxOutputTokens: number } | undefined;
    if (cached) return cached.maxOutputTokens;
    const maximum = await anthropicOutputMaximum(
      c.endpoint ?? providerEndpoints.anthropic, key, request, this.fetcher,
    );
    request.signal.throwIfAborted();
    // A running snapshot may outlive removal of its catalog record. Finish the
    // request, but cache only metadata owned by a model that is still saved.
    if (this.db.prepare("SELECT 1 FROM provider_models WHERE connectionId=? AND id=?")
      .get(c.id, request.modelId)) {
      this.db.prepare("INSERT OR REPLACE INTO provider_output_metadata VALUES (?,?,?,?)")
        .run(c.id, request.modelId, revision, maximum);
    }
    return maximum;
  }
  private provider(snapshot: ExecutionSnapshot) {
    const c = this.connection(snapshot.connectionId);
    if (c.provider !== snapshot.provider)
      throw new ConnectionError(
        "The Provider changed. Retry with the current preset.",
        409,
      );
    let key: string | null = null;
    try {
      key = c.credential ? this.secrets.decrypt(c.credential, c.id) : null;
    } catch {
      throw new ConnectionError(
        "Cannot unlock the Provider key. Replace it and retry.",
        503,
      );
    }
    if (c.provider === "codex") return null;
    return new TextProvider(
      c.provider,
      c.endpoint ??
        providerEndpoints[c.provider as keyof typeof providerEndpoints],
      key,
      this.fetcher,
      (request) => this.outputMaximum(c, key, request),
    );
  }
  async generate(
    snapshot: ExecutionSnapshot,
    request: TextRequest,
  ): Promise<TextResult> {
    const provider = this.provider(snapshot);
    if (provider) return provider.generate(request);
    if (!this.codex.executeText)
      throw new ConnectionError(
        "This Codex adapter does not support text execution.",
        503,
      );
    return this.codex.executeText(snapshot.connectionId, request);
  }
  async toolRound(
    snapshot: ExecutionSnapshot,
    request: TaskRequest,
  ): Promise<ToolRound> {
    const c = this.connection(snapshot.connectionId);
    if (c.provider !== snapshot.provider)
      throw new ConnectionError("Provider changed during execution.", 409);
    let key: string | null = null;
    try {
      key = c.credential ? this.secrets.decrypt(c.credential, c.id) : null;
    } catch {
      throw new ConnectionError("Cannot unlock Provider key.", 503);
    }
    if (c.provider === "codex")
      throw new ConnectionError("Use the Codex task runtime.", 409);
    return new ToolProvider(
      c.provider,
      c.endpoint ??
        providerEndpoints[c.provider as keyof typeof providerEndpoints],
      key,
      this.fetcher,
      async (media) => {
        const revision = createHash("sha256")
          .update(JSON.stringify([c.provider, c.endpoint, c.credential]))
          .digest("hex");
        const now = Date.now();
        this.db
          .prepare(
            "DELETE FROM provider_media_files WHERE expiresAt<? OR (connectionId=? AND revision!=?)",
          )
          .run(now, c.id, revision);
        const cached = this.db
          .prepare(
            "SELECT fileId FROM provider_media_files WHERE connectionId=? AND versionId=?",
          )
          .get(c.id, media.versionId) as { fileId: string } | undefined;
        if (cached) return cached.fileId;
        const data = new FormData();
        data.append("purpose", "assistants");
        data.append(
          "file",
          new Blob([Buffer.from(media.data, "base64")], {
            type: media.mediaType,
          }),
          media.name,
        );
        const result = await this.fetcher(
          (c.endpoint ?? providerEndpoints.xai) + "/files",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${key}` },
            body: data,
            signal: request.signal,
            redirect: "error",
          },
        );
        if (!result.ok) {
          await result.body?.cancel();
          throw new ConnectionError(
            "Provider file upload failed. Retry explicitly.",
            409,
          );
        }
        // File-upload responses are metadata only; bound before parsing.
        const reader = result.body?.getReader();
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        try {
          if (reader)
            while (true) {
              const v = await reader.read();
              if (v.done) break;
              bytes += v.value.length;
              if (bytes > 65536)
                throw new ConnectionError(
                  "Invalid Provider file response.",
                  409,
                );
              chunks.push(v.value);
            }
        } finally {
          await reader?.cancel();
          reader?.releaseLock();
        }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof value.id !== "string" || value.id.length > 200)
          throw new ConnectionError("Invalid Provider file identity.", 409);
        this.db
          .prepare(
            "DELETE FROM provider_media_files WHERE rowid IN (SELECT rowid FROM provider_media_files ORDER BY expiresAt LIMIT max(0,(SELECT count(*) FROM provider_media_files)-127))",
          )
          .run();
        this.db
          .prepare(
            "INSERT OR REPLACE INTO provider_media_files VALUES (?,?,?,?,?)",
          )
          .run(c.id, media.versionId, revision, value.id, now + 60 * 60 * 1000);
        return value.id;
      },
      (request) => this.outputMaximum(c, key, request),
    )
      .round(request)
      .catch((error) => {
        this.db
          .prepare("DELETE FROM provider_media_files WHERE connectionId=?")
          .run(c.id);
        throw error;
      });
  }
  async countTaskTokens(snapshot: ExecutionSnapshot, request: TaskRequest) {
    const c = this.connection(snapshot.connectionId);
    if (!["openai", "anthropic", "google"].includes(c.provider)) return null;
    const key = c.credential ? this.secrets.decrypt(c.credential, c.id) : null;
    return new ToolProvider(
      c.provider as Exclude<ConnectionProvider, "codex">,
      c.endpoint ??
        providerEndpoints[c.provider as keyof typeof providerEndpoints],
      key,
      this.fetcher,
    ).countTokens(request);
  }
  async executeTask(
    snapshot: ExecutionSnapshot,
    request: TaskRequest,
  ): Promise<TextResult> {
    if (!this.codex.executeTask)
      throw new ConnectionError(
        "This Codex adapter does not support task tools.",
        503,
      );
    return this.codex.executeTask(snapshot.connectionId, request);
  }
  async countTokens(snapshot: ExecutionSnapshot, request: TextRequest) {
    const provider = this.provider(snapshot);
    return provider
      ? provider.countTokens(request)
      : Buffer.byteLength(
          JSON.stringify([request.instructions, request.messages]),
        ) + 128;
  }
  async close() {
    await this.codex.close();
    if (this.memory) await rm(this.directory, { recursive: true, force: true });
  }
}
