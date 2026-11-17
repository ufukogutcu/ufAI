import { InputError } from "./validation.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ToolOwner } from "./process-service.js";
import type { UserInputRequest } from "./vault-types.js";
import type { Vault } from "./vault.js";
import { vaultObject } from "./vault.js";
import { ConnectionError } from "./model-providers.js";
import { validateAnswer, validateDefinition } from "./user-input-validation.js";

const stamp = () => new Date().toISOString();
const kinds = ["secret", "text", "single_choice", "multi_select", "form"];
const states = ["pending", "fulfilled", "declined", "cancelled"];
export const inputColumns = "r.id,r.kind,r.workspaceId,r.agentId,r.taskId,r.name,r.purpose,r.secretId,r.expectedRevision,r.state,r.createdAt,r.updatedAt,r.definition,r.answer,t.title AS taskTitle";
export function readInput(row: any): UserInputRequest {
  const { definition, answer, ...metadata } = row;
  return row.kind === "secret" ? metadata : { ...metadata, definition: JSON.parse(definition), answer: answer === null ? null : JSON.parse(answer) };
}
export class UserInputConflict extends ConnectionError {
  constructor(public request: UserInputRequest) { super("This request was already answered or closed. Review the saved outcome.", 409); }
}
export interface InputFilters { agentId?: string; workspaceId?: string; kind?: string; state?: string }
export class UserInputs {
  constructor(private db: Database.Database, private vault: Vault, private changed: (workspaceId: string) => void) {}
  detail(id: string): UserInputRequest {
    const row = this.db.prepare(`SELECT ${inputColumns} FROM user_input_requests r JOIN agent_tasks t ON t.id=r.taskId WHERE r.id=?`).get(id);
    if (!row) throw new ConnectionError("Input request no longer exists.", 404);
    return readInput(row);
  }
  list(taskId?: string, offset = 0, limit = 100, filters: InputFilters = {}) {
    const clauses: string[] = [], values: string[] = [];
    for (const [key, value] of Object.entries({ taskId, ...filters })) if (value !== undefined) {
      if ((key === "kind" && !kinds.includes(value)) || (key === "state" && !states.includes(value)) || !["taskId", "agentId", "workspaceId", "kind", "state"].includes(key)) throw new ConnectionError("Invalid request filter.", 400);
      clauses.push(`r.${key}=?`); values.push(value);
    }
    if (!taskId && !filters.state) clauses.push("r.state='pending'");
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    return { items: this.db.prepare(`SELECT ${inputColumns} FROM user_input_requests r JOIN agent_tasks t ON t.id=r.taskId ${where} ORDER BY r.createdAt,r.id LIMIT ? OFFSET ?`).all(...values, limit, offset).map(readInput),
      total: (this.db.prepare(`SELECT count(*) n FROM user_input_requests r ${where}`).get(...values) as { n: number }).n };
  }
  request(owner: ToolOwner, args: Record<string, any>, callId: string) {
    this.vault.messaging!.assertOwner(owner);
    if (!kinds.includes(args.kind)) throw new ConnectionError("Choose a supported input kind.", 400);
    const old = this.db.prepare("SELECT id FROM user_input_requests WHERE turnId=? AND callId=?").get(owner.turnId, callId) as { id: string } | undefined;
    if (old) return this.detail(old.id);
    if ((this.db.prepare("SELECT count(*) n FROM user_input_requests WHERE taskId=? AND state='pending'").get(owner.taskId) as { n: number }).n >= 10) throw new ConnectionError("Resolve existing input requests first (maximum ten pending per task).", 429);
    if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 160 || typeof args.purpose !== "string" || !args.purpose.trim() || args.purpose.length > 2000) throw new ConnectionError("Supply a name (1–160 characters) and purpose (1–2,000 characters).", 400);
    if (args.kind !== "secret" && args.secretId !== undefined) throw new ConnectionError("Only secret requests can reference Vault entries.", 400);
    if (args.kind === "secret" && args.definition !== undefined) throw new ConnectionError("Secret requests use the existing private Vault controls.", 400);
    let definition = {};
    try { definition = args.kind === "secret" ? {} : validateDefinition(args.kind, args.definition); }
    catch (error) {
      if (error instanceof InputError) throw new ConnectionError("Invalid input definition: " + Object.values(error.fields).join(" "), 400);
      throw error;
    }
    const secret = args.secretId ? this.vault.detail(args.secretId) : null;
    const turn = this.db.prepare("SELECT envelope FROM agent_turns WHERE id=?").get(owner.turnId) as { envelope: string };
    const agent = this.db.prepare("SELECT name FROM agents WHERE id=?").get(owner.agentId) as { name: string };
    const id = randomUUID(), now = stamp(), name = args.name.trim();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO user_input_requests(id,kind,workspaceId,agentId,taskId,turnId,callId,name,purpose,secretId,expectedRevision,returnEnvelope,createdAt,updatedAt,definition) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, args.kind, owner.workspaceId, owner.agentId, owner.taskId, owner.turnId, callId, name, args.purpose, secret?.id ?? null, secret?.revision ?? null, turn.envelope, now, now, JSON.stringify(definition));
      this.db.prepare("INSERT INTO workspace_inbox(id,workspaceId,agentId,agentName,taskId,content,attachments,createdAt,userInputRequestId) VALUES(?,?,?,?,?,?,'[]',?,?)")
        .run(randomUUID(), owner.workspaceId, owner.agentId, agent.name, owner.taskId, (args.kind === "secret" ? "Private input requested: " : "Your input requested: ") + name, now, id);
    })();
    this.vault.messaging!.inputsChanged(owner.taskId);
    this.changed(owner.workspaceId);
    return this.detail(id);
  }
  cancel(id: string, owner?: ToolOwner) {
    const r = this.detail(id);
    if (owner && (r.taskId !== owner.taskId || r.agentId !== owner.agentId)) throw new ConnectionError("Input request is outside this task.", 403);
    this.db.prepare("UPDATE user_input_requests SET state='cancelled',updatedAt=? WHERE id=? AND state='pending'").run(stamp(), id);
    if (owner) this.db.prepare("UPDATE user_input_requests SET deliveredTurnId=? WHERE id=? AND state='cancelled'").run(owner.turnId, id);
    this.notify(r);
    return this.detail(id);
  }
  resolve(id: string, input: unknown) {
    const r = this.detail(id);
    const b = vaultObject(input, r.kind === "secret" ? ["value", "secretId", "decline", "expectedRevision"] : ["answer", "decline"]);
    const result = this.db.transaction(() => {
      const current = this.detail(id);
      if (current.kind === "secret" && current.state !== "pending") return current;
      const declining = b.decline === true;
      if (Object.hasOwn(b, "decline") && (!declining || Object.keys(b).length !== 1)) throw new ConnectionError("Decline must be submitted alone.", 400);
      const answer = current.kind !== "secret" && !declining ? validateAnswer(current.kind, current.name, current.definition!, b.answer) : null;
      if (current.state !== "pending") {
        if ((declining && current.state === "declined") || (!declining && current.state === "fulfilled" && JSON.stringify(current.answer) === JSON.stringify(answer))) return current;
        throw new UserInputConflict(current);
      }
      const task = this.db.prepare("SELECT status FROM agent_tasks WHERE id=?").get(current.taskId) as { status: string };
      if (["cancelled", "completed"].includes(task.status)) throw new ConnectionError("The source task has ended. Cancel this request.", 409);
      let secretId: string | null = null;
      if (current.kind === "secret" && !declining) {
        if (typeof b.secretId === "string" && !Object.hasOwn(b, "value")) secretId = this.vault.detail(b.secretId).id;
        else if (Object.hasOwn(b, "value") && !b.secretId) {
          if (current.expectedRevision !== null && !current.secretId) throw new ConnectionError("The secret was deleted. Create a new request.", 409);
          secretId = this.vault.save({ ...(!current.secretId ? { name: current.name } : {}), value: b.value,
            ...(current.secretId ? { expectedRevision: b.expectedRevision ?? current.expectedRevision } : {}) }, current.secretId ?? undefined).id;
        } else throw new ConnectionError("Enter a value, select an existing secret, or decline.", 400);
      }
      this.db.prepare("UPDATE user_input_requests SET state=?,secretId=?,answer=?,updatedAt=? WHERE id=? AND state='pending'")
        .run(declining ? "declined" : "fulfilled", secretId, answer === null ? null : JSON.stringify(answer), stamp(), id);
      this.db.prepare("UPDATE workspace_inbox SET readAt=? WHERE userInputRequestId=?").run(stamp(), id);
      return this.detail(id);
    })();
    this.notify(result);
    return result;
  }
  private notify(r: UserInputRequest) { this.changed(r.workspaceId); this.vault.messaging?.inputsChanged(r.taskId); }
}
