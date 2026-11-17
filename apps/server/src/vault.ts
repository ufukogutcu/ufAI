import { UserInputs, type InputFilters } from "./user-inputs.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ConnectionSecrets } from "./connection-secrets.js";
import type { ToolOwner } from "./process-service.js";
import type { MessagingService } from "./messaging.js";
import type { BrowserService } from "./browser-service.js";
import type { UserInputRequest, VaultSecret } from "./vault-types.js";
import { ConnectionError } from "./model-providers.js";

const columns = "id,name,description,revision,createdAt,updatedAt";
const stamp = () => new Date().toISOString();
function fail(message: string, status = 400): never { throw new ConnectionError(message, status); }
function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) fail("Enter " + label + " (up to " + max + " characters).");
  return value as string;
}
export function vaultObject(value: unknown, keys?: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Supply a JSON object.");
  const result = value as Record<string, any>;
  if (keys && Object.keys(result).some(k => !keys.includes(k))) fail("Unknown field. Use only the documented fields.");
  return result;
}
export function redactSecrets<T>(value: T, secrets: Iterable<string>): T {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    for (const variant of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString("base64")]) variants.add(variant);
  }
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  const clean = (v: unknown): any => {
    if (typeof v === "string") { for (const s of ordered) v = (v as string).split(s).join("[secret hidden]"); return v; }
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    return v;
  };
  return clean(value);
}

export class Vault {
  readonly inputs: UserInputs;
  messaging?: MessagingService;
  browser?: BrowserService;
  private active = 0;
  private stopped = false;
  private controllers = new Set<AbortController>();
  constructor(readonly db: Database.Database, private crypto: ConnectionSecrets,
    private changed: (workspaceId: string) => void, private fetcher: typeof fetch = fetch) { this.inputs = new UserInputs(db, this, changed); }
  list(query = "", offset = 0, limit = 100) {
    const where = "WHERE instr(lower(name || ' ' || description),lower(?))>0";
    return { items: this.db.prepare("SELECT " + columns + " FROM vault_secrets " + where + " ORDER BY createdAt,id LIMIT ? OFFSET ?").all(query, limit, offset) as VaultSecret[],
      total: (this.db.prepare("SELECT count(*) n FROM vault_secrets " + where).get(query) as { n: number }).n };
  }
  detail(id: string): VaultSecret {
    const entry = this.db.prepare("SELECT " + columns + " FROM vault_secrets WHERE id=?").get(id) as VaultSecret | undefined;
    if (!entry) fail("Secret no longer exists. Choose another secret.", 404);
    return entry;
  }
  value(id: string): string {
    const entry = this.db.prepare("SELECT ciphertext FROM vault_secrets WHERE id=?").get(id) as { ciphertext: string } | undefined;
    if (!entry) fail("Secret no longer exists. Choose another secret.", 404);
    try { return this.crypto.decrypt(entry.ciphertext, "vault:" + id); }
    catch { return fail("Cannot unlock this secret. Restore the original credential key and database backup.", 503); }
  }
  private changedAll() {
    for (const w of this.db.prepare("SELECT id FROM workspaces").all() as { id: string }[]) this.changed(w.id);
  }
  save(input: unknown, id?: string) {
    const b = vaultObject(input, ["name", "description", "value", "expectedRevision"]);
    const previous = id ? this.detail(id) : undefined;
    if (previous && b.expectedRevision !== previous.revision) fail("Secret changed. Reload it before saving.", 409);
    if (!previous && (this.db.prepare("SELECT count(*) n FROM vault_secrets").get() as { n: number }).n >= 256) fail("Vault is full (256 secrets). Delete unused entries first.", 409);
    const name = text(b.name ?? previous?.name, "a secret name", 160).trim();
    const description = text(b.description ?? previous?.description ?? "", "a description", 2000, true);
    if ((!previous || Object.hasOwn(b, "value")) && (typeof b.value !== "string" || b.value.length < 1 || b.value.length > 8192)) fail("Enter a secret value (1–8192 characters).");
    // Never generate a replacement key while encrypted records already exist.
    const first = this.db.prepare("SELECT id FROM vault_secrets LIMIT 1").get() as { id: string } | undefined;
    if (first) this.value(first.id);
    else {
      const prior = this.db.prepare("SELECT credential AS ciphertext,id AS aad FROM connections WHERE credential IS NOT NULL UNION ALL SELECT secrets AS ciphertext,'mcp:' || id AS aad FROM mcp_servers LIMIT 1").get() as { ciphertext: string; aad: string } | undefined;
      if (prior) {
        try { this.crypto.decrypt(prior.ciphertext, prior.aad); }
        catch { fail("Cannot unlock existing credentials. Restore the original credential key before saving Vault secrets.", 503); }
      }
    }
    const secretId = id ?? randomUUID(), now = stamp();
    let ciphertext: string | undefined;
    if (Object.hasOwn(b, "value")) {
      try { ciphertext = this.crypto.encrypt(b.value, "vault:" + secretId); }
      catch { fail("Cannot save the secret. Check the credential key and directory permissions.", 503); }
    }
    if (previous) this.db.prepare("UPDATE vault_secrets SET name=?,description=?,ciphertext=coalesce(?,ciphertext),revision=revision+1,updatedAt=? WHERE id=? AND revision=?")
      .run(name, description, ciphertext ?? null, now, secretId, previous.revision);
    else this.db.prepare("INSERT INTO vault_secrets(id,name,description,ciphertext,createdAt,updatedAt) VALUES(?,?,?,?,?,?)")
      .run(secretId, name, description, ciphertext!, now, now);
    this.changedAll();
    return this.detail(secretId);
  }
  delete(id: string, revision: unknown) {
    const entry = this.detail(id);
    if (revision !== entry.revision) fail("Secret changed. Reload it before deleting.", 409);
    this.db.transaction(() => {
      this.db.prepare("UPDATE user_input_requests SET state='cancelled',updatedAt=? WHERE secretId=? AND state='pending'").run(stamp(), id);
      this.db.prepare("DELETE FROM vault_secrets WHERE id=?").run(id);
    })();
    this.changedAll();
  }
  requestDetail(id: string): UserInputRequest { return this.inputs.detail(id); }
  requests(taskId?: string, offset = 0, limit = 100, filters: InputFilters = {}) { return this.inputs.list(taskId, offset, limit, filters); }
  request(owner: ToolOwner, args: Record<string, any>, callId: string) { return this.inputs.request(owner, args, callId); }
  cancel(id: string, owner?: ToolOwner) { return this.inputs.cancel(id, owner); }
  resolve(id: string, input: unknown) { return this.inputs.resolve(id, input); }
  async execute(owner: ToolOwner, name: string, args: Record<string, any>, signal: AbortSignal, callId: string) {
    this.messaging!.assertOwner(owner);
    if (name === "vault_list") return this.list(args.query ?? "", args.offset ?? 0, args.limit ?? 50);
    if (name === "user_input_request") return { userInput: this.request(owner, args, callId) };
    if (name === "user_input_status" || name === "user_input_cancel") {
      const r = this.requestDetail(args.requestId);
      if (r.taskId !== owner.taskId || r.agentId !== owner.agentId) fail("Input request is outside this task.", 403);
      return { userInput: name === "user_input_cancel" ? this.cancel(r.id, owner) : r };
    }
    if (name === "vault_browser_fill") {
      if (!this.browser) fail("Browser is unavailable.", 503);
      return this.browser!.fillSecret(owner.agentId, args.ref, this.value(args.secretId), signal);
    }
    if (name === "vault_http_request") return this.http(args, signal);
    return fail("Unknown Vault tool.");
  }
  async http(args: Record<string, any>, signal: AbortSignal) {
    if (this.stopped) fail("Vault is shutting down.", 503);
    if (this.active >= 4) fail("Vault requests are busy. Retry shortly.", 429);
    let url: URL;
    try { url = new URL(args.url); } catch { return fail("Enter a complete HTTP(S) URL."); }
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) fail("Use HTTPS, or loopback HTTP, without URL credentials or fragments.");
    const used: string[] = [];
    const resolve = (v: unknown, depth = 0): any => {
      if (depth > 20) fail("Request body is too deeply nested.");
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const object = v as Record<string, unknown>;
        if (Object.hasOwn(object, "secretId")) {
          vaultObject(object, ["secretId", "prefix"]);
          const value = this.value(text(object.secretId, "a secret ID", 100)); used.push(value);
          return text(object.prefix ?? "", "a prefix", 100, true) + value;
        }
        return Object.fromEntries(Object.entries(object).map(([k, x]) => [k, resolve(x, depth + 1)]));
      }
      if (Array.isArray(v)) return v.map(x => resolve(x, depth + 1));
      return v;
    };
    const headers = new Headers();
    try {
      for (const [k, v] of Object.entries(vaultObject(args.headers ?? {}))) {
        if (["host", "cookie", "connection", "content-length", "transfer-encoding"].includes(k.toLowerCase()) || k.toLowerCase().startsWith("sec-")) fail("That request header is not supported.");
        const value = resolve(v); if (typeof value !== "string") fail("Header values must be text or secret references.");
        headers.set(k, value);
      }
      // Agent requests must never pass ufAI's private dashboard route guards.
      headers.set("Sec-Fetch-Site", "cross-site");
      let body: string | undefined;
      if (args.json !== undefined && args.form !== undefined) fail("Supply JSON or form fields, not both.");
      if (args.json !== undefined) { body = JSON.stringify(resolve(args.json)); headers.set("Content-Type", "application/json"); }
      if (args.form !== undefined) {
        const form = resolve(args.form);
        if (Object.values(form).some(v => typeof v !== "string")) fail("Form values must be text or secret references.");
        body = new URLSearchParams(form).toString(); headers.set("Content-Type", "application/x-www-form-urlencoded");
      }
      if (body && Buffer.byteLength(body) > 256 * 1024) fail("Request body exceeds the size limit.", 413);
      this.active++;
      const controller = new AbortController(); this.controllers.add(controller);
      try {
        const response = await this.fetcher(url, { method: args.method ?? "GET", headers, body, redirect: "manual",
          signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30000)]) });
        const reader = response.body?.getReader();
        const cap = 24001;
        const chunks: Buffer[] = []; let size = 0, truncated = false;
        try {
          if (reader) while (true) {
            const { done, value } = await reader.read(); if (done) break;
            const remaining = cap - size; chunks.push(Buffer.from(value.subarray(0, remaining))); size += Math.min(value.length, remaining);
            if (value.length > remaining || size >= cap) { truncated = true; break; }
          }
        } finally { await reader?.cancel().catch(() => {}); }
        // Omit oversized bodies entirely: cutting before redaction could expose
        // a partial secret that crosses the byte boundary.
        const oversized = size > 24000 || truncated;
        const clean = redactSecrets({ status: response.status, contentType: response.headers.get("content-type"), body: oversized ? "" : Buffer.concat(chunks).toString("utf8") }, used);
        return { ...clean, body: Buffer.from(clean.body).subarray(0, 24000).toString("utf8"), truncated: oversized || Buffer.byteLength(clean.body) > 24000 };
      } finally { this.controllers.delete(controller); this.active--; }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ConnectionError) throw new ConnectionError(redactSecrets(error.message, used), error.statusCode);
      return fail("Private HTTP request failed. Check the destination and method; effects may have occurred.", 409);
    }
  }
  close() { this.stopped = true; for (const c of this.controllers) c.abort(); }
}
