import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { Agent, WorkspaceDuplicateInput, WorkspaceDuplication, WorkspaceViewport } from "./contracts.js";
import type { TriggerInput } from "./trigger-types.js";
import type { ManagedFiles } from "./managed-files.js";
import type { Triggers } from "./triggers.js";
import { guard } from "./connections.js";
import { ConnectionError } from "./model-providers.js";
import { managedDirectory } from "./host-paths.js";
import { InputError, objectBody, workspaceInput } from "./validation.js";
import { nextTime } from "./trigger-schedule.js";

const flags = ["includeConnections", "includeSkills", "includeMcp", "includeMemories", "includeWorkspaceFiles", "includeAgentFiles", "includeTriggers"] as const;
interface OperationRow {
  id: string; sourceWorkspaceId: string; destinationId: string; input: string; snapshot: string | null;
  state: WorkspaceDuplication["state"]; phase: WorkspaceDuplication["phase"]; error: string | null; createdAt: string; updatedAt: string;
}
type Link = { id: string; sourceAgentId: string; targetAgentId: string; sourceAnchorAngle: number; targetAnchorAngle: number };
type Memory = { agentId: string; key: string; content: string; kind: string };
type Dependency = { triggerId: string; skillId: string; fingerprint: string; snapshot: string };
type TriggerRow = { id: string; agentId: string; input: string; dependencyError: string | null; dispatchError: string | null; retryAt: string | null };
interface Snapshot {
  agents: (Omit<Agent, "appearance"> & { appearance: string })[];
  viewport: WorkspaceViewport;
  links: Link[];
  skills: { agentId: string; skillId: string; enabled: number }[];
  mcp: { agentId: string; serverId: string; enabled: number }[];
  memories: Memory[];
  triggers: TriggerRow[];
  dependencies: Dependency[];
  sources: { id: string; name: string; enabled: number }[];
}

function input(body: unknown): WorkspaceDuplicateInput {
  const value = objectBody(body), errors: Record<string, string> = {};
  for (const key of Object.keys(value)) if (!["name", "description", "requestId", ...flags].includes(key)) errors[key] = "Unknown field.";
  for (const key of flags) if (typeof value[key] !== "boolean") errors[key] = "Provide true or false.";
  if (typeof value.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.requestId)) errors.requestId = "Use a request ID of 8–100 letters, numbers, underscores or hyphens.";
  if (Object.keys(errors).length) throw new InputError(errors);
  return { ...workspaceInput({ name: value.name, description: value.description }), requestId: value.requestId as string,
    ...Object.fromEntries(flags.map(key => [key, value[key]])) } as WorkspaceDuplicateInput;
}

/** One bounded worker; destination owners are invisible until the final transaction. */
export class WorkspaceDuplications {
  private worker?: Promise<void>;
  private stopped = false;
  constructor(private db: Database.Database, private files: ManagedFiles, private triggers: Triggers) {}
  private row(id: string) {
    const row = this.db.prepare("SELECT * FROM workspace_duplications WHERE id=?").get(id) as OperationRow | undefined;
    if (!row) throw new ConnectionError("Duplication not found.", 404);
    return row;
  }
  get(id: string): WorkspaceDuplication {
    const row = this.row(id);
    return { id: row.id, sourceWorkspaceId: row.sourceWorkspaceId, name: JSON.parse(row.input).name,
      state: row.state, phase: row.phase, error: row.error, workspaceId: row.state === "completed" ? row.destinationId : null,
      createdAt: row.createdAt, updatedAt: row.updatedAt };
  }
  list(): WorkspaceDuplication[] {
    return (this.db.prepare("SELECT id FROM workspace_duplications ORDER BY updatedAt DESC,id LIMIT 51").all() as { id: string }[]).map(row => this.get(row.id));
  }
  private assertSource(id: string) {
    if (!this.db.prepare("SELECT id FROM workspaces WHERE id=?").get(id)) throw new ConnectionError("Source workspace no longer exists.", 404);
    this.files.assertAvailable(id);
    if (this.db.prepare("SELECT 1 FROM deletion_operations WHERE workspaceId=? AND state!='completed' LIMIT 1").get(id))
      throw new ConnectionError("Finish workspace or agent deletion before duplicating.", 409);
  }
  private capture(sourceId: string, options: WorkspaceDuplicateInput): Snapshot {
    this.assertSource(sourceId);
    const rows = <T>(sql: string) => this.db.prepare(sql).all(sourceId) as T[];
    return {
      agents: rows<Snapshot["agents"][number]>("SELECT * FROM agents WHERE workspaceId=? ORDER BY createdAt,id"),
      viewport: this.db.prepare("SELECT x,y,zoom FROM workspace_viewports WHERE workspaceId=?").get(sourceId) as WorkspaceViewport ?? { x: 0, y: 0, zoom: 1 },
      links: options.includeConnections ? rows<Link>("SELECT * FROM communication_links WHERE workspaceId=? AND state='active'") : [],
      skills: options.includeSkills ? rows("SELECT e.* FROM agent_skills e JOIN agents a ON a.id=e.agentId WHERE a.workspaceId=?") : [],
      mcp: options.includeMcp ? rows("SELECT e.* FROM agent_mcp_servers e JOIN agents a ON a.id=e.agentId WHERE a.workspaceId=?") : [],
      memories: options.includeMemories ? rows<Memory>("SELECT m.* FROM agent_memories m JOIN agents a ON a.id=m.agentId WHERE a.workspaceId=? AND m.deleted=0") : [],
      triggers: options.includeTriggers ? rows<TriggerRow>("SELECT * FROM agent_triggers WHERE workspaceId=? AND deleted=0") : [],
      dependencies: options.includeTriggers ? rows<Dependency>("SELECT d.* FROM trigger_dependencies d JOIN agent_triggers t ON t.id=d.triggerId WHERE t.workspaceId=? AND t.deleted=0") : [],
      sources: options.includeTriggers ? rows("SELECT id,name,enabled FROM trigger_event_sources WHERE workspaceId=?") : [],
    };
  }
  private available() {
    if (this.stopped) throw new ConnectionError("Duplication is shutting down. Retry shortly.", 503);
    if (this.worker || this.db.prepare("SELECT id FROM workspace_duplications WHERE state IN ('pending','running') LIMIT 1").get())
      throw new ConnectionError("Another workspace is being duplicated. Retry when it finishes.", 409);
  }
  create(sourceId: string, body: unknown) {
    const options = input(body), encoded = JSON.stringify(options);
    const existing = this.db.prepare("SELECT * FROM workspace_duplications WHERE id=?").get(options.requestId) as OperationRow | undefined;
    if (existing) {
      if (existing.sourceWorkspaceId !== sourceId || existing.input !== encoded) throw new ConnectionError("This request ID already belongs to another duplication. Start a new request.", 409);
      return this.get(existing.id);
    }
    this.available();
    const stamp = new Date().toISOString();
    this.db.transaction(() => {
      const snapshot = this.capture(sourceId, options);
      this.db.prepare("INSERT INTO workspace_duplications VALUES (?,?,?,?,?,'pending','pending',NULL,?,?)")
        .run(options.requestId, sourceId, randomUUID(), encoded, JSON.stringify(snapshot), stamp, stamp);
    })();
    const result = this.get(options.requestId);
    this.kick(options.requestId);
    return result;
  }
  retry(id: string) {
    const row = this.row(id);
    if (row.state !== "failed") return this.get(id);
    this.available();
    // Recapture after a failure: the user may have repaired files or configuration.
    this.db.transaction(() => {
      const snapshot = this.capture(row.sourceWorkspaceId, JSON.parse(row.input));
      this.db.prepare("UPDATE workspace_duplications SET state='pending',phase='pending',error=NULL,snapshot=?,updatedAt=? WHERE id=?")
        .run(JSON.stringify(snapshot), new Date().toISOString(), id);
    })();
    const result = this.get(id);
    this.kick(id);
    return result;
  }
  private staging(row: OperationRow) { return join(this.files.root, "duplications", row.destinationId); }
  private destination(row: OperationRow) { return join(this.files.root, "workspaces", row.destinationId); }
  private async clean(row: OperationRow) {
    await this.files.verifyRoot();
    for (const parent of ["duplications", "workspaces"]) {
      try { await managedDirectory(join(this.files.root, parent)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      await rm(join(this.files.root, parent, row.destinationId), { recursive: true, force: true });
    }
  }
  async start() {
    const interrupted = this.db.prepare("SELECT * FROM workspace_duplications WHERE state!='completed'").all() as OperationRow[];
    for (const row of interrupted) {
      let error = row.error ?? "Duplication was interrupted. Retry to copy the workspace again.";
      try { await this.clean(row); } catch { error = "Could not clean interrupted files. Check managed folder permissions and retry."; }
      this.db.prepare("UPDATE workspace_duplications SET state='failed',phase='failed',error=?,snapshot=NULL WHERE id=?").run(error, row.id);
    }
    this.prune();
  }
  private prune() {
    this.db.prepare("DELETE FROM workspace_duplications WHERE id IN (SELECT id FROM workspace_duplications WHERE state IN ('completed','failed') ORDER BY updatedAt DESC,id LIMIT -1 OFFSET 50)").run();
  }
  private kick(id: string) {
    this.worker = this.run(id).finally(() => { this.worker = undefined; });
  }
  async close() { this.stopped = true; await this.worker; }
  private checkpoint() { if (this.stopped) throw new Error("Duplication was interrupted. Retry after restarting ufAI."); }
  private async copyTree(source: string, target: string) {
    this.checkpoint();
    await managedDirectory(source);
    await managedDirectory(target, true);
    const before = await lstat(source, { bigint: true });
    const directory = await opendir(source);
    for await (const entry of directory) {
      this.checkpoint();
      const from = join(source, entry.name), to = join(target, entry.name);
      const info = await lstat(from, { bigint: true });
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`Cannot copy “${entry.name}”: links and special files are unsupported.`);
      if (info.isDirectory()) { await this.copyTree(from, to); continue; }
      if (!(info.mode & 0o444n)) throw new Error(`Cannot read “${entry.name}”. Check its permissions and retry.`);
      // No shared inodes, link traversal, or buffering entire files in memory.
      await managedDirectory(source);
      const reader = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await reader.stat({ bigint: true });
        if (opened.ino !== info.ino || opened.dev !== info.dev || !opened.isFile()) throw new Error(`“${entry.name}” changed. Retry when files are stable.`);
        const writer = await open(to, "wx", Number(info.mode & 0o777n));
        try {
          const buffer = Buffer.allocUnsafe(256 * 1024);
          let position = 0;
          while (position < Number(info.size)) {
            this.checkpoint();
            const { bytesRead } = await reader.read(buffer, 0, Math.min(buffer.length, Number(info.size) - position), position);
            if (!bytesRead) throw new Error(`“${entry.name}” changed during copying. Retry when files are stable.`);
            let written = 0;
            while (written < bytesRead) {
              const result = await writer.write(buffer, written, bytesRead - written, position + written);
              if (!result.bytesWritten) throw new Error(`Could not write “${entry.name}”. Check available disk space and retry.`);
              written += result.bytesWritten;
            }
            position += bytesRead;
          }
          const after = await reader.stat({ bigint: true }), pathAfter = await lstat(from, { bigint: true });
          if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs || pathAfter.ino !== info.ino || pathAfter.dev !== info.dev)
            throw new Error(`“${entry.name}” changed during copying. Retry when files are stable.`);
        } finally { await writer.close(); }
      } finally { await reader.close(); }
    }
    const after = await lstat(source, { bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error("A folder changed during copying. Retry when files are stable.");
  }
  private async run(id: string) {
    const row = this.row(id), options = JSON.parse(row.input) as WorkspaceDuplicateInput, snapshot = JSON.parse(row.snapshot!) as Snapshot;
    const agents = new Map(snapshot.agents.map(agent => [agent.id, randomUUID()]));
    const sources = new Map(snapshot.sources.map(source => [source.id, randomUUID()]));
    try {
      await this.clean(row);
      this.db.prepare("UPDATE workspace_duplications SET state='running',phase='copying',updatedAt=? WHERE id=?").run(new Date().toISOString(), id);
      await this.files.verifyRoot();
      await managedDirectory(join(this.files.root, "duplications"), true);
      const stage = this.staging(row);
      await managedDirectory(stage, true);
      if (options.includeWorkspaceFiles) await this.copyTree(this.files.location("workspace", row.sourceWorkspaceId).path, join(stage, "shared"));
      else await managedDirectory(join(stage, "shared"), true);
      for (const agent of snapshot.agents) {
        const target = join(stage, "agents", agents.get(agent.id)!, "files");
        if (options.includeAgentFiles) await this.copyTree(this.files.location("agent", agent.id).path, target);
        else await managedDirectory(target, true);
      }
      this.checkpoint();
      this.assertSource(row.sourceWorkspaceId);
      this.db.prepare("UPDATE workspace_duplications SET phase='publishing',updatedAt=? WHERE id=?").run(new Date().toISOString(), id);
      await this.files.verifyRoot();
      await managedDirectory(join(this.files.root, "workspaces"), true);
      await rename(stage, this.destination(row));
      this.checkpoint();
      const stamp = this.triggers.now();
      this.db.transaction(() => {
        this.assertSource(row.sourceWorkspaceId);
        this.db.prepare("INSERT INTO workspaces(id,name,description,createdAt,updatedAt,sortOrder) VALUES (?,?,?,?,?,(SELECT COALESCE(MAX(sortOrder),-1)+1 FROM workspaces))").run(row.destinationId, options.name, options.description, stamp, stamp);
        for (const a of snapshot.agents) this.db.prepare("INSERT INTO agents(id,workspaceId,name,instructions,presetId,x,y,appearance,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(agents.get(a.id), row.destinationId, a.name, a.instructions, a.presetId, a.x, a.y, a.appearance, stamp, stamp);
        this.db.prepare("INSERT INTO workspace_viewports(workspaceId,x,y,zoom) VALUES (?,?,?,?)").run(row.destinationId, snapshot.viewport.x, snapshot.viewport.y, snapshot.viewport.zoom);
        for (const link of snapshot.links) this.db.prepare("INSERT INTO communication_links(id,workspaceId,sourceAgentId,targetAgentId,state,createdAt,sourceAnchorAngle,targetAnchorAngle) VALUES (?,?,?,?,'active',?,?,?)")
          .run(randomUUID(), row.destinationId, agents.get(link.sourceAgentId), agents.get(link.targetAgentId), stamp, link.sourceAnchorAngle, link.targetAnchorAngle);
        for (const e of snapshot.skills) this.db.prepare("INSERT INTO agent_skills(agentId,skillId,enabled) VALUES (?,?,?)").run(agents.get(e.agentId), e.skillId, e.enabled);
        for (const e of snapshot.mcp) this.db.prepare("INSERT INTO agent_mcp_servers(agentId,serverId,enabled) VALUES (?,?,?)").run(agents.get(e.agentId), e.serverId, e.enabled);
        for (const m of snapshot.memories) this.db.prepare("INSERT INTO agent_memories(id,agentId,key,content,kind,sources,createdAt,updatedAt) VALUES (?,?,?,?,?,'[]',?,?)")
          .run(randomUUID(), agents.get(m.agentId), m.key, m.content, m.kind, stamp, stamp);
        for (const s of snapshot.sources) this.db.prepare("INSERT INTO trigger_event_sources(id,workspaceId,name,tokenHash,enabled,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)")
          .run(sources.get(s.id), row.destinationId, s.name, createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex"), s.enabled, stamp, stamp);
        for (const t of snapshot.triggers) {
          const triggerId = randomUUID(), definition = JSON.parse(t.input) as TriggerInput;
          if (definition.when.kind === "event") {
            if (definition.when.sourceId) {
              const sourceId = sources.get(definition.when.sourceId);
              if (!sourceId) throw new Error("A trigger's event source is unavailable. Repair the source trigger and retry.");
              definition.when.sourceId = sourceId;
            }
            if (definition.when.eventType.startsWith("ufai.")) for (const filter of definition.when.filters ?? []) {
              const mapped = (v: unknown) => typeof v === "string" ? (filter.path === "agentId" ? agents.get(v) : filter.path === "workspaceId" && v === row.sourceWorkspaceId ? row.destinationId : undefined) ?? v : v;
              if (["agentId", "workspaceId"].includes(filter.path)) filter.value = Array.isArray(filter.value) ? filter.value.map(mapped) : mapped(filter.value);
            }
          }
          const encoded = JSON.stringify(definition);
          this.db.prepare("INSERT INTO agent_triggers(id,agentId,workspaceId,revision,input,dependencyError,dispatchError,retryAt,createdAt,updatedAt) VALUES (?,?,?,1,?,?,?,?,?,?)")
            .run(triggerId, agents.get(t.agentId), row.destinationId, encoded, t.dependencyError, t.dispatchError, t.retryAt, stamp, stamp);
          const sequence = (this.db.prepare("UPDATE trigger_clock SET value=value+1 WHERE id=1 RETURNING value").get() as { value: number }).value;
          this.db.prepare("INSERT INTO trigger_revisions(sequence,triggerId,revision,input,startedAt,nextAt) VALUES (?,?,1,?,?,?)")
            .run(sequence, triggerId, encoded, stamp, definition.enabled ? nextTime(definition.when, stamp) : null);
          for (const d of snapshot.dependencies.filter(d => d.triggerId === t.id)) this.db.prepare("INSERT INTO trigger_dependencies(triggerId,skillId,fingerprint,snapshot) VALUES (?,?,?,?)")
            .run(triggerId, d.skillId, d.fingerprint, d.snapshot);
        }
        this.db.prepare("UPDATE managed_locations SET state='ready',error=NULL WHERE workspaceId=?").run(row.destinationId);
        this.db.prepare("UPDATE workspace_duplications SET state='completed',phase='completed',snapshot=NULL,error=NULL,updatedAt=? WHERE id=?").run(stamp, id);
      })();
    } catch (error) {
      let message = error instanceof ConnectionError || (error instanceof Error && !('code' in error)) ? (error as Error).message : "Could not copy workspace files or settings. Check permissions and availability, then retry.";
      try { await this.clean(row); } catch { message += " Temporary files could not be removed; check managed folder permissions before retrying."; }
      this.db.prepare("UPDATE workspace_duplications SET state='failed',phase='failed',snapshot=NULL,error=?,updatedAt=? WHERE id=?").run(message, new Date().toISOString(), id);
    }
    this.prune();
    if (this.get(id).state === "completed") this.triggers.execution.workspaceEvent(row.destinationId, "workspace");
  }
}

export function registerWorkspaceDuplications(app: FastifyInstance, service: WorkspaceDuplications) {
  app.addHook("onRequest", async req => {
    if (/^\/api\/workspace-duplications(?:\/|\?|$)/.test(req.url) || /^\/api\/workspaces\/[^/]+\/duplicate(?:\?|$)/.test(req.url)) guard(req);
  });
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/duplicate", async (req, reply) => reply.code(202).send(service.create(req.params.id, req.body)));
  app.get("/api/workspace-duplications", async () => ({ items: service.list() }));
  app.get<{ Params: { id: string } }>("/api/workspace-duplications/:id", async req => service.get(req.params.id));
  app.post<{ Params: { id: string } }>("/api/workspace-duplications/:id/retry", async (req, reply) => reply.code(202).send(await service.retry(req.params.id)));
}
