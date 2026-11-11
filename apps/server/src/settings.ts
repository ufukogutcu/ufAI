import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type {
  AppSettings,
  SettingsResponse,
  Workspace,
  WorkspaceViewport,
} from "./contracts.js";
import { readTheme } from "./themes.js";
import { InputError, objectBody } from "./validation.js";

type SettingsRow = Omit<AppSettings, "sidebarExpanded"> & {
  sidebarExpanded: number;
};

export function registerSettings(
  app: FastifyInstance,
  database: Database.Database,
) {
  const getSettings = database.prepare(
    "SELECT activeThemeId, activeWorkspaceId, sidebarExpanded FROM app_settings WHERE id = 1",
  );
  const getWorkspace = database.prepare(
    "SELECT * FROM workspaces WHERE id = ?",
  );
  function read(): SettingsResponse {
    const row = getSettings.get() as SettingsRow;
    return {
      settings: { ...row, sidebarExpanded: Boolean(row.sidebarExpanded) },
      activeTheme: readTheme(database, row.activeThemeId)!,
      activeWorkspace: row.activeWorkspaceId
        ? (getWorkspace.get(row.activeWorkspaceId) as Workspace)
        : null,
    };
  }
  app.get("/api/settings", async () => read());
  app.patch("/api/settings", async (request) => {
    const patch = objectBody(request.body);
    const fields: Record<string, string> = {};
    for (const key of Object.keys(patch))
      if (
        !["activeThemeId", "activeWorkspaceId", "sidebarExpanded"].includes(key)
      )
        fields[key] = "Unknown field.";
    if (
      Object.hasOwn(patch, "activeThemeId") &&
      (typeof patch.activeThemeId !== "string" ||
        !readTheme(database, patch.activeThemeId))
    )
      fields.activeThemeId = "Choose an existing theme.";
    if (
      Object.hasOwn(patch, "activeWorkspaceId") &&
      patch.activeWorkspaceId !== null &&
      (typeof patch.activeWorkspaceId !== "string" ||
        !getWorkspace.get(patch.activeWorkspaceId))
    )
      fields.activeWorkspaceId = "Choose an existing workspace, or null.";
    if (
      Object.hasOwn(patch, "sidebarExpanded") &&
      typeof patch.sidebarExpanded !== "boolean"
    )
      fields.sidebarExpanded = "Provide true or false.";
    if (Object.keys(fields).length) throw new InputError(fields);
    const settings = { ...read().settings, ...patch } as AppSettings;
    database
      .prepare(
        `UPDATE app_settings SET activeThemeId = @activeThemeId,
      activeWorkspaceId = @activeWorkspaceId, sidebarExpanded = @sidebarExpanded WHERE id = 1`,
      )
      .run({ ...settings, sidebarExpanded: Number(settings.sidebarExpanded) });
    return read();
  });

  const getViewport = database.prepare(
    "SELECT x, y, zoom FROM workspace_viewports WHERE workspaceId = ?",
  );
  const saveViewport =
    database.prepare(`INSERT INTO workspace_viewports VALUES (@workspaceId, @x, @y, @zoom)
    ON CONFLICT(workspaceId) DO UPDATE SET x = excluded.x, y = excluded.y, zoom = excluded.zoom`);
  function readViewport(id: string): WorkspaceViewport {
    return (
      (getViewport.get(id) as WorkspaceViewport | undefined) ?? {
        x: 0,
        y: 0,
        zoom: 1,
      }
    );
  }
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/viewport",
    async (request, reply) => {
      if (!getWorkspace.get(request.params.id))
        return reply.code(404).send({ error: "Workspace not found." });
      return readViewport(request.params.id);
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/workspaces/:id/viewport",
    async (request, reply) => {
      if (!getWorkspace.get(request.params.id))
        return reply.code(404).send({ error: "Workspace not found." });
      const patch = objectBody(request.body);
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (!["x", "y", "zoom"].includes(key)) fields[key] = "Unknown field.";
        else if (typeof value !== "number" || !Number.isFinite(value))
          fields[key] = "Provide a finite number.";
        else if (key === "zoom" && (value < 0.25 || value > 2))
          fields.zoom = "Use zoom between 0.25 and 2.";
      }
      if (Object.keys(fields).length) throw new InputError(fields);
      const viewport = { ...readViewport(request.params.id), ...patch };
      saveViewport.run({ workspaceId: request.params.id, ...viewport });
      return viewport;
    },
  );
}
