import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  DiscoveredModel,
  ModelTestResult,
  ProviderModel,
  ModelSelection,
  SelectionImpact,
} from "./contracts.js";
import { ConnectionError } from "./model-providers.js";
import { InputError, objectBody } from "./validation.js";

type Row = Omit<
  ProviderModel,
  | "contextWindow"
  | "maxOutputTokens"
  | "enabled"
  | "manual"
  | "available"
  | "lastTest"
  | "legacyLimits"
> & {
  enabled: number;
  manual: number;
  available: number;
  lastTest: string | null;
  legacyLimits: string;
};
export class SelectionConfirmationError extends Error {
  constructor(public impact: SelectionImpact) {
    super("Saving will clear model choices from linked presets. Confirm to continue.");
  }
}
export class ProviderModels {
  constructor(private db: Database.Database) {}
  private public(row: Row): ProviderModel {
    return {
      ...row,
      enabled: !!row.enabled,
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
  count(connectionId: string, enabledOnly = false): number {
    return (
      this.db
        .prepare(
          `SELECT count(*) AS total FROM provider_models WHERE connectionId = ?${enabledOnly ? " AND enabled = 1" : ""}`,
        )
        .get(connectionId) as { total: number }
    ).total;
  }
  list(connectionId: string, limit: number, offset: number, query = "", enabledOnly = false) {
    // instr treats search text literally, including SQL wildcard characters.
    const args = [connectionId, query.toLowerCase(), query.toLowerCase()];
    const where =
      `connectionId = ? AND (instr(lower(name), ?) > 0 OR instr(lower(id), ?) > 0)${enabledOnly ? " AND enabled = 1" : ""}`;
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
  selection(connectionId: string, query = ""): { items: ModelSelection[] } {
    const rows = this.db
      .prepare(`SELECT id, enabled FROM provider_models WHERE connectionId = ?
        AND (instr(lower(name), ?) > 0 OR instr(lower(id), ?) > 0) ORDER BY id LIMIT 5000`)
      .all(connectionId, query.toLowerCase(), query.toLowerCase()) as {
        id: string;
        enabled: number;
      }[];
    return {
      items: rows.map((row) => ({ id: row.id, enabled: !!row.enabled })),
    };
  }
  // Called within the connection save transaction; confirmation failures roll back every write.
  applySelection(
    connectionId: string,
    input: unknown,
    confirmationToken: unknown,
    requireSelected: boolean,
  ) {
    if (!Array.isArray(input) || input.length > 5000)
      throw new InputError({ models: "Choose at most 5,000 model changes." });
    const catalog = new Set(
      this.selection(connectionId).items.map((model) => model.id),
    );
    const seen = new Set<string>();
    for (const item of input) {
      if (
        !item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).some((key) => key !== "id" && key !== "enabled") ||
        typeof item.id !== "string" || typeof item.enabled !== "boolean" ||
        !catalog.has(item.id) || seen.has(item.id)
      )
        throw new InputError({
          models: "Choose each model once from this Provider’s saved catalog.",
        });
      seen.add(item.id);
    }
    if (
      confirmationToken !== undefined &&
      (typeof confirmationToken !== "string" || !/^[a-f0-9]{64}$/.test(confirmationToken))
    )
      throw new InputError({ models: "Invalid selection confirmation." });
    const changes = input as ModelSelection[];
    const update = this.db.prepare(
      "UPDATE provider_models SET enabled = ? WHERE connectionId = ? AND id = ?",
    );
    for (const item of changes)
      update.run(item.enabled ? 1 : 0, connectionId, item.id);
    if (requireSelected && !this.count(connectionId, true))
      throw new InputError({
        models: "Select at least one model before saving the Provider.",
      });
    const normalized = [...changes].sort((a, b) => a.id.localeCompare(b.id));
    const hash = createHash("sha256").update(JSON.stringify([connectionId, normalized]));
    const impact: SelectionImpact = {
      total: 0,
      presets: [],
      confirmationToken: "",
    };
    const affected = this.db.prepare(`SELECT p.id, p.name, p.modelId FROM model_presets p
      JOIN provider_models m ON m.connectionId = p.connectionId AND m.id = p.modelId
      WHERE p.connectionId = ? AND m.enabled = 0 ORDER BY p.id`);
    for (const value of affected.iterate(connectionId)) {
      const row = value as { id: string; name: string; modelId: string };
      hash.update(JSON.stringify(row));
      impact.total++;
      if (impact.presets.length < 20)
        impact.presets.push({ id: row.id, name: row.name });
    }
    impact.confirmationToken = hash.digest("hex");
    if (impact.total && confirmationToken !== impact.confirmationToken)
      throw new SelectionConfirmationError(impact);
    this.db.prepare(`UPDATE model_presets SET modelId = NULL, contextWindow = NULL, maxOutputTokens = NULL
      WHERE connectionId = ? AND modelId IN (SELECT id FROM provider_models WHERE connectionId = ? AND enabled = 0)`)
      .run(connectionId, connectionId);
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
    const model = this.get(connectionId, id);
    if (!model) throw new ConnectionError("Model not found.", 404);
    if (!draft && model.enabled && this.count(connectionId, true) <= 1)
      throw new ConnectionError(
        "A saved Provider needs at least one selected model. Delete the Provider instead.",
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
