import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import catalog from "@ufai/theme-catalog" with { type: "json" };
import type { Theme, ThemeColors, ThemeInput, ThemeMode } from "./contracts.js";
import { InputError, objectBody, pagination } from "./validation.js";

const hex = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
function normalizeColor(value: string): string {
  const digits = value.slice(1).toLowerCase();
  return `#${digits.length < 5 ? [...digits].map((digit) => digit + digit).join("") : digits}`;
}
function resolveColors(
  mode: ThemeMode,
  colors: Partial<ThemeColors>,
): ThemeColors {
  return Object.fromEntries(
    Object.entries(catalog.tokens).map(([key, token]) => [
      key,
      normalizeColor(colors[key as keyof ThemeColors] ?? token[mode]),
    ]),
  ) as ThemeColors;
}
const builtIns: Theme[] = catalog.themes.map((theme) => ({
  ...theme,
  mode: theme.mode as ThemeMode,
  builtIn: true,
  colors: resolveColors(theme.mode as ThemeMode, {}),
  createdAt: null,
  updatedAt: null,
}));

type ThemeRow = Omit<Theme, "colors" | "builtIn"> & { colors: string };
function fromRow(row: ThemeRow): Theme {
  return {
    ...row,
    builtIn: false,
    colors: resolveColors(row.mode, JSON.parse(row.colors)),
  };
}
export function readTheme(
  database: Database.Database,
  id: string,
): Theme | undefined {
  const builtin = builtIns.find((theme) => theme.id === id);
  if (builtin) return builtin;
  const row = database.prepare("SELECT * FROM themes WHERE id = ?").get(id) as
    ThemeRow | undefined;
  return row ? fromRow(row) : undefined;
}
function themeInput(body: unknown, existing?: ThemeInput): ThemeInput {
  const patch = objectBody(body);
  const input = { ...existing, ...patch };
  const fields: Record<string, string> = {};
  for (const key of Object.keys(patch))
    if (!["name", "mode", "colors"].includes(key))
      fields[key] = "Unknown field.";
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 120
  )
    fields.name = "Enter a name between 1 and 120 characters.";
  if (input.mode !== "light" && input.mode !== "dark")
    fields.mode = "Choose Light or Dark for native controls.";
  const colors: Partial<ThemeColors> = { ...existing?.colors };
  if (input.colors === undefined && !existing)
    fields.colors =
      "Provide a color object (it may be empty to use base colors).";
  if (patch.colors !== undefined || !existing) {
    if (
      !patch.colors ||
      typeof patch.colors !== "object" ||
      Array.isArray(patch.colors)
    )
      fields.colors = "Provide a color object.";
    else
      for (const [key, value] of Object.entries(patch.colors)) {
        if (!Object.hasOwn(catalog.tokens, key))
          fields[`colors.${key}`] = "Unknown color scope.";
        else if (typeof value !== "string" || !hex.test(value))
          fields[`colors.${key}`] =
            "Use a hex color, such as #7051b3 or #7051b380.";
        else colors[key as keyof ThemeColors] = normalizeColor(value);
      }
  }
  if (Object.keys(fields).length) throw new InputError(fields);
  return {
    name: (input.name as string).trim(),
    mode: input.mode as ThemeMode,
    colors: resolveColors(input.mode as ThemeMode, colors),
  };
}

export function registerThemes(
  app: FastifyInstance,
  database: Database.Database,
) {
  const list = database.prepare(
    "SELECT * FROM themes ORDER BY createdAt, id LIMIT ? OFFSET ?",
  );
  const count = database.prepare("SELECT count(*) AS total FROM themes");
  const get = database.prepare("SELECT * FROM themes WHERE id = ?");
  const insert = database.prepare(
    "INSERT INTO themes VALUES (@id, @name, @mode, @colors, @createdAt, @updatedAt)",
  );
  const update = database.prepare(
    "UPDATE themes SET name = @name, mode = @mode, colors = @colors, updatedAt = @updatedAt WHERE id = @id",
  );
  const remove = database.prepare("DELETE FROM themes WHERE id = ?");
  app.get("/api/themes", async (request) => {
    const { limit, offset } = pagination(request.query);
    const defaults = builtIns.slice(offset, offset + limit);
    const custom = list.all(
      limit - defaults.length,
      Math.max(0, offset - builtIns.length),
    ) as ThemeRow[];
    return {
      items: [...defaults, ...custom.map(fromRow)],
      total: builtIns.length + (count.get() as { total: number }).total,
    };
  });
  app.get<{ Params: { id: string } }>(
    "/api/themes/:id",
    async (request, reply) => {
      const builtin = builtIns.find((theme) => theme.id === request.params.id);
      if (builtin) return builtin;
      const row = get.get(request.params.id) as ThemeRow | undefined;
      return row
        ? fromRow(row)
        : reply.code(404).send({ error: "Theme not found." });
    },
  );
  app.post("/api/themes", async (request, reply) => {
    const input = themeInput(request.body);
    const now = new Date().toISOString();
    const theme: Theme = {
      ...input,
      id: randomUUID(),
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    };
    insert.run({
      ...input,
      id: theme.id,
      colors: JSON.stringify(input.colors),
      createdAt: now,
      updatedAt: now,
    });
    return reply.code(201).send(theme);
  });
  app.patch<{ Params: { id: string } }>(
    "/api/themes/:id",
    async (request, reply) => {
      if (builtIns.some((theme) => theme.id === request.params.id))
        return reply.code(403).send({
          error:
            "Default themes are locked. Duplicate this theme to customize it.",
        });
      const row = get.get(request.params.id) as ThemeRow | undefined;
      if (!row) return reply.code(404).send({ error: "Theme not found." });
      const input = themeInput(request.body, fromRow(row));
      update.run({
        ...input,
        id: row.id,
        colors: JSON.stringify(input.colors),
        updatedAt: new Date().toISOString(),
      });
      return fromRow(get.get(row.id) as ThemeRow);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/themes/:id",
    async (request, reply) => {
      if (builtIns.some((theme) => theme.id === request.params.id))
        return reply
          .code(403)
          .send({ error: "Default themes cannot be deleted." });
      const removed = database.transaction(() => {
        const result = remove.run(request.params.id);
        if (result.changes)
          database
            .prepare(
              "UPDATE app_settings SET activeThemeId = 'light-mode' WHERE activeThemeId = ?",
            )
            .run(request.params.id);
        return result.changes;
      })();
      if (!removed) return reply.code(404).send({ error: "Theme not found." });
      return reply.code(204).send();
    },
  );
}
