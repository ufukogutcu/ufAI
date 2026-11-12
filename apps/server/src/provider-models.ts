import type Database from "better-sqlite3";
import type {
  DiscoveredModel,
  ModelTestResult,
  ProviderModel,
} from "./contracts.js";
import { ConnectionError } from "./model-providers.js";
import { InputError, objectBody } from "./validation.js";

type Row = Omit<
  ProviderModel,
  | "contextWindow"
  | "maxOutputTokens"
  | "manual"
  | "available"
  | "lastTest"
  | "legacyLimits"
> & {
  manual: number;
  available: number;
  lastTest: string | null;
  legacyLimits: string;
};
export class ProviderModels {
  constructor(private db: Database.Database) {}
  private public(row: Row): ProviderModel {
    return {
      ...row,
      manual: !!row.manual,
      available: !!row.available,
      lastTest: row.lastTest
        ? (JSON.parse(row.lastTest) as ModelTestResult)
        : null,
      legacyLimits: JSON.parse(
        row.legacyLimits,
      ) as ProviderModel["legacyLimits"],
      contextWindow: row.contextWindowOverride ?? row.discoveredContextWindow,
      maxOutputTokens:
        row.maxOutputTokensOverride ?? row.discoveredMaxOutputTokens,
    };
  }
  get(connectionId: string, id: string): ProviderModel | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM provider_models WHERE connectionId = ? AND id = ?",
      )
      .get(connectionId, id) as Row | undefined;
    return row ? this.public(row) : undefined;
  }
  count(connectionId: string): number {
    return (
      this.db
        .prepare(
          "SELECT count(*) AS total FROM provider_models WHERE connectionId = ?",
        )
        .get(connectionId) as { total: number }
    ).total;
  }
  list(connectionId: string, limit: number, offset: number, query = "") {
    // instr treats search text literally, including SQL wildcard characters.
    const args = [connectionId, query.toLowerCase(), query.toLowerCase()];
    const where =
      "connectionId = ? AND (instr(lower(name), ?) > 0 OR instr(lower(id), ?) > 0)";
    return {
      items: (
        this.db
          .prepare(
            `SELECT * FROM provider_models WHERE ${where} ORDER BY name, id LIMIT ? OFFSET ?`,
          )
          .all(...args, limit, offset) as Row[]
      ).map((row) => this.public(row)),
      total: (
        this.db
          .prepare(
            `SELECT count(*) AS total FROM provider_models WHERE ${where}`,
          )
          .get(...args) as { total: number }
      ).total,
    };
  }
  save(connectionId: string, body: unknown, id?: string) {
    const patch = objectBody(body);
    const errors: Record<string, string> = {};
    for (const key of Object.keys(patch))
      if (
        ![
          "id",
          "name",
          "contextWindowOverride",
          "maxOutputTokensOverride",
        ].includes(key)
      )
        errors[key] = "Unknown field.";
    if (id && patch.id !== undefined && patch.id !== id)
      errors.id = "Add a new model to change its ID.";
    const existing = id ? this.get(connectionId, id) : undefined;
    if (id && !existing) throw new ConnectionError("Model not found.", 404);
    const modelId = id ?? patch.id;
    if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 200)
      errors.id = "Enter a model ID between 1 and 200 characters.";
    if (
      !id &&
      typeof modelId === "string" &&
      this.get(connectionId, modelId.trim())
    )
      errors.id = "This model is already in the list.";
    if (!id && this.count(connectionId) >= 5000)
      throw new ConnectionError("Keep at most 5,000 models per Provider.", 409);
    const name = patch.name ?? existing?.name ?? modelId;
    if (typeof name !== "string" || !name.trim() || name.length > 300)
      errors.name = "Enter a model name between 1 and 300 characters.";
    const limits = {
      contextWindowOverride: existing?.contextWindowOverride ?? null,
      maxOutputTokensOverride: existing?.maxOutputTokensOverride ?? null,
    };
    for (const key of [
      "contextWindowOverride",
      "maxOutputTokensOverride",
    ] as const) {
      if (patch[key] !== undefined) {
        const value = patch[key];
        if (
          value !== null &&
          (typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value < 1)
        )
          errors[key] =
            "Enter a positive safe integer, or leave empty for automatic.";
        else limits[key] = value as number | null;
      }
    }
    const context =
      limits.contextWindowOverride ?? existing?.discoveredContextWindow;
    const output =
      limits.maxOutputTokensOverride ?? existing?.discoveredMaxOutputTokens;
    if (context && output && output > context)
      errors.maxOutputTokensOverride =
        "Maximum output must not exceed context.";
    if (Object.keys(errors).length) throw new InputError(errors);
    if (existing)
      this.db
        .prepare(
          `UPDATE provider_models SET name = ?, contextWindowOverride = ?, maxOutputTokensOverride = ?, legacyLimits = ? WHERE connectionId = ? AND id = ?`,
        )
        .run(
          (name as string).trim(),
          limits.contextWindowOverride,
          limits.maxOutputTokensOverride,
          patch.contextWindowOverride !== undefined ||
            patch.maxOutputTokensOverride !== undefined
            ? "[]"
            : JSON.stringify(existing.legacyLimits),
          connectionId,
          id,
        );
    else
      this.db
        .prepare(
          `INSERT INTO provider_models (connectionId, id, name, contextWindowOverride, maxOutputTokensOverride, manual, available) VALUES (?, ?, ?, ?, ?, 1, 0)`,
        )
        .run(
          connectionId,
          (modelId as string).trim(),
          (name as string).trim(),
          limits.contextWindowOverride,
          limits.maxOutputTokensOverride,
        );
    return this.get(connectionId, (modelId as string).trim())!;
  }
  merge(connectionId: string, models: DiscoveredModel[]) {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE provider_models SET available = 0 WHERE connectionId = ?",
        )
        .run(connectionId);
      const upsert = this.db
        .prepare(`INSERT INTO provider_models (connectionId, id, name, discoveredContextWindow, discoveredMaxOutputTokens) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(connectionId, id) DO UPDATE SET name = excluded.name,
        discoveredContextWindow = excluded.discoveredContextWindow, discoveredMaxOutputTokens = excluded.discoveredMaxOutputTokens, available = 1`);
      for (const m of models)
        upsert.run(
          connectionId,
          m.id,
          m.name,
          m.contextWindow,
          m.maxOutputTokens,
        );
      if (this.count(connectionId) > 5000)
        throw new ConnectionError(
          "The merged model list exceeds 5,000 entries. Remove unused models first.",
          409,
        );
    })();
  }
  remove(connectionId: string, id: string, draft: boolean) {
    if (!this.get(connectionId, id))
      throw new ConnectionError("Model not found.", 404);
    if (!draft && this.count(connectionId) <= 1)
      throw new ConnectionError(
        "A saved Provider needs at least one model. Delete the Provider instead.",
        409,
      );
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM provider_models WHERE connectionId = ? AND id = ?",
        )
        .run(connectionId, id);
      this.db
        .prepare(
          "UPDATE model_presets SET modelId = NULL, contextWindow = NULL, maxOutputTokens = NULL WHERE connectionId = ? AND modelId = ?",
        )
        .run(connectionId, id);
    })();
  }
  tested(connectionId: string, id: string, result: ModelTestResult) {
    this.db
      .prepare(
        "UPDATE provider_models SET lastTest = ? WHERE connectionId = ? AND id = ?",
      )
      .run(JSON.stringify(result), connectionId, id);
  }
  invalidate(connectionId: string) {
    this.db
      .prepare(
        "UPDATE provider_models SET lastTest = NULL WHERE connectionId = ?",
      )
      .run(connectionId);
  }
}
