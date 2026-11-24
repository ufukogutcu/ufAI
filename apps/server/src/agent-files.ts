import { execFile } from "node:child_process";
import { constants, type ReadStream } from "node:fs";
import { lstat, open, opendir, rm } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AgentFileEntry, AgentFileListing } from "./contracts.js";
import type { ManagedFiles } from "./managed-files.js";
import { guard } from "./connections.js";
import { ConnectionError } from "./model-providers.js";
import { objectBody, pagination } from "./validation.js";

export interface AgentFilesOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injectable OS adapter; tests never launch a desktop application. */
  launch?: (command: string, args: string[]) => Promise<void>;
}

export function fileManagerCommand(platform: NodeJS.Platform, path: string) {
  switch (platform) {
    case "linux": return { command: "xdg-open", args: [path] };
    case "darwin": return { command: "open", args: [path] };
    case "win32": return { command: "explorer.exe", args: [path] };
    default: throw new ConnectionError("Opening a file manager is unavailable on this system. Use Copy path instead.", 503);
  }
}

function launch(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: 5000, maxBuffer: 16384, windowsHide: true, shell: false }, (error) => {
      // Explorer can return 1 after successfully handing off to its existing instance.
      if (error && !(command === "explorer.exe" && error.code === 1 && !error.killed)) reject(error);
      else resolve();
    });
  });
}

type FileOwner = { kind: "agent" | "workspace"; ownerId: string };

const ownerKey = ({ kind, ownerId }: FileOwner) => `${kind}:${ownerId}`;

function filePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || /[\\\0]/.test(value) || /^[a-z]:/i.test(value) ||
    (process.platform === "win32" && /[:<>"|?*]|[. ](?:\/|$)/.test(value)) ||
    (value !== "" && value.split("/").some(p => !p || p === "." || p === "..")))
    throw new ConnectionError("Choose a path inside this folder.", 400);
  return value;
}

function readableError(error: unknown): never {
  if (error instanceof ConnectionError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR")
    throw new ConnectionError("This file or folder is no longer available. Refresh the folder or go Up.", 404);
  if (code === "EACCES" || code === "EPERM")
    throw new ConnectionError("Cannot access this file or folder. Check its permissions, then retry.", 403);
  throw new ConnectionError("Cannot access this file or folder. Check the folder and retry.", 409);
}

export class AgentFiles {
  private stopped = false;
  private reading = 0;
  private opening = 0;
  private downloads = new Map<ReadStream, { owner: FileOwner; workspaceId: string; path: string }>();
  private removing = new Map<string, { owner: FileOwner; workspaceId: string; path: string; promise: Promise<void> }>();
  constructor(private files: ManagedFiles, private options: AgentFilesOptions = {}) {}

  private available(owner: FileOwner) {
    if (this.stopped) throw new ConnectionError("Files are shutting down. Try again shortly.", 503);
    const location = this.files.location(owner.kind, owner.ownerId);
    this.files.assertAvailable(location.workspaceId, owner.kind === "agent" ? owner.ownerId : undefined);
    if (location.state !== "ready")
      throw new ConnectionError(location.state === "pending" ? "Creating the folder. Retry shortly." : "The folder is unavailable. Retry folder setup.", 409);
    return location;
  }

  private assertNotRemoving(owner: FileOwner, path: string) {
    const operation = this.removing.get(ownerKey(owner));
    if (operation && (path === operation.path || path.startsWith(`${operation.path}/`)))
      throw new ConnectionError("This file or folder is being deleted. Refresh after deletion finishes.", 409);
  }

  private async resolve(owner: FileOwner, value: unknown, directory: boolean, removing = false) {
    const path = filePath(value), location = this.available(owner);
    if (!removing) this.assertNotRemoving(owner, path);
    if (owner.kind === "agent") await this.files.verifyAgentDirectory(owner.ownerId);
    else await this.files.verifyDirectory(owner.kind, owner.ownerId);
    const full = join(location.path, ...path.split("/"));
    const rel = relative(location.path, full);
    if (rel === ".." || rel.startsWith(`..${sep}`))
      throw new ConnectionError("Choose a path inside this folder.", 400);
    // Check every component without following links, including the leaf.
    let current = location.path;
    for (const part of path ? path.split("/") : []) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new ConnectionError("Links cannot be opened from Files. Use your file manager instead.", 409);
      if ((current !== full || directory) && !info.isDirectory())
        throw new ConnectionError("This folder is no longer available. Refresh the folder or go Up.", 404);
    }
    this.available(owner);
    if (!removing) this.assertNotRemoving(owner, path);
    return { full, path, location };
  }

  private async read<T>(action: () => Promise<T>) {
    if (this.reading >= 4) throw new ConnectionError("Files are busy. Retry shortly.", 429);
    this.reading++;
    try { return await action(); }
    catch (error) { readableError(error); }
    finally { this.reading--; }
  }

  list(owner: FileOwner, path: unknown, limit: number, offset: number) {
    return this.read(async (): Promise<AgentFileListing> => {
      const target = await this.resolve(owner, path, true);
      const names: { name: string; directory: boolean }[] = [];
      const directory = await opendir(target.full);
      for await (const entry of directory) {
        if (names.length >= 10000)
          throw new ConnectionError("This folder has more than 10,000 entries. Use Open in file manager to browse it.", 413);
        names.push({ name: entry.name, directory: entry.isDirectory() });
      }
      names.sort((a, b) => Number(b.directory) - Number(a.directory) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "en") || a.name.localeCompare(b.name, "en"));
      const selected = names.slice(offset, offset + limit), items: AgentFileEntry[] = [];
      // Only collect metadata for this page, with eight filesystem reads at a time.
      for (let i = 0; i < selected.length; i += 8) {
        items.push(...await Promise.all(selected.slice(i, i + 8).map(async ({ name }): Promise<AgentFileEntry> => {
          const path = target.path ? `${target.path}/${name}` : name;
          try {
            filePath(path);
            const info = await lstat(join(target.full, name));
            return { name, path, kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "unavailable",
              size: info.isFile() ? info.size : null, modifiedAt: info.mtime.toISOString() };
          } catch { return { name, path, kind: "unavailable", size: null, modifiedAt: null }; }
        })));
      }
      await this.resolve(owner, path, true);
      return { path: target.path, items, total: names.length };
    });
  }

  download(owner: FileOwner, path: unknown) {
    return this.read(async () => {
      const target = await this.resolve(owner, path, false);
      const before = await lstat(target.full);
      if (!before.isFile()) throw new ConnectionError("Only regular files can be downloaded.", 409);
      // NONBLOCK prevents an exchanged FIFO from hanging open; NOFOLLOW rejects leaf links.
      const file = await open(target.full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino)
          throw new ConnectionError("This file changed. Refresh the folder and try again.", 409);
        await this.resolve(owner, path, false);
        this.available(owner);
        this.assertNotRemoving(owner, target.path);
        if (this.downloads.size >= 16) throw new ConnectionError("Too many downloads. Wait for one to finish and retry.", 429);
        const stream = file.createReadStream();
        this.downloads.set(stream, { owner, workspaceId: target.location.workspaceId, path: target.path });
        stream.once("close", () => this.downloads.delete(stream));
        return { stream, name: basename(target.full) };
      } catch (error) { await file.close(); throw error; }
    });
  }

  async openFolder(owner: FileOwner, path: unknown) {
    if (this.opening >= 2) throw new ConnectionError("The file manager is busy. Retry shortly.", 429);
    this.opening++;
    try {
      const target = await this.read(() => this.resolve(owner, path, true));
      const platform = this.options.platform ?? process.platform;
      const env = this.options.env ?? process.env;
      if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY)
        throw new ConnectionError("No desktop session is available on the ufAI server. Use Copy path instead.", 503);
      const { command, args } = fileManagerCommand(platform, target.full);
      this.available(owner);
      this.assertNotRemoving(owner, target.path);
      try { await (this.options.launch ?? launch)(command, args); }
      catch { throw new ConnectionError("Could not open the file manager on the ufAI server. Check that a desktop file manager is installed, or use Copy path.", 503); }
    } finally { this.opening--; }
  }

  async remove(owner: FileOwner, value: unknown, expectedKind: unknown, confirmed: unknown) {
    const path = filePath(value);
    if (!path || confirmed !== true || (expectedKind !== "file" && expectedKind !== "directory"))
      throw new ConnectionError("Choose a file or folder and confirm its permanent deletion first.", 400);
    const location = this.available(owner);
    this.assertNotRemoving(owner, path);
    if (this.removing.has(ownerKey(owner)) || this.removing.size >= 2)
      throw new ConnectionError("File deletion is busy. Wait for a deletion to finish and retry.", 429);
    const promise = this.removeEntry(owner, path, expectedKind);
    this.removing.set(ownerKey(owner), { owner, workspaceId: location.workspaceId, path, promise });
    try { await promise; }
    catch (error) { readableError(error); }
    finally { this.removing.delete(ownerKey(owner)); }
  }

  private async removeEntry(owner: FileOwner, path: string, expectedKind: "file" | "directory") {
    await this.resolve(owner, path, false, true);
    await this.closeStreams([...this.downloads].filter(([, download]) => ownerKey(download.owner) === ownerKey(owner) &&
      (download.path === path || download.path.startsWith(`${path}/`))).map(([stream]) => stream));
    // Revalidate after settling downloads; do not turn a stale file selection into recursive removal.
    const target = await this.resolve(owner, path, false, true);
    const info = await lstat(target.full);
    if (info.isSymbolicLink() || (expectedKind === "file" ? !info.isFile() : !info.isDirectory()))
      throw new ConnectionError("This file or folder changed. Refresh the folder and try again.", 409);
    this.available(owner);
    // rm does not follow interior symlinks. No force/retry: missing entries and partial failures stay visible.
    await rm(target.full, { recursive: expectedKind === "directory", force: false, maxRetries: 0 });
  }

  private async closeStreams(streams: ReadStream[]) {
    await Promise.all(streams.map(stream => new Promise<void>(resolve => {
      if (stream.closed) return resolve();
      stream.once("close", resolve);
      stream.destroy();
    })));
  }

  async settle(scope?: FileOwner) {
    const matches = ({ owner, workspaceId }: { owner: FileOwner; workspaceId: string }) =>
      !scope || (scope.kind === "workspace" ? workspaceId === scope.ownerId : ownerKey(owner) === ownerKey(scope));
    await Promise.allSettled([...this.removing.values()].filter(matches).map(operation => operation.promise));
    await this.closeStreams([...this.downloads].filter(([, download]) => matches(download)).map(([stream]) => stream));
  }

  async close() { this.stopped = true; await this.settle(); }
}

export function registerAgentFiles(app: FastifyInstance, browser: AgentFiles) {
  for (const [segment, kind] of [["agents", "agent"], ["workspaces", "workspace"]] as const) {
    const route = `/api/${segment}/:id/files`;
    app.delete<{ Params: { id: string } }>(route, async (req, reply) => {
      guard(req);
      const body = objectBody(req.body);
      await browser.remove({ kind, ownerId: req.params.id }, body.path, body.expectedKind, body.confirmFilesDeletion);
      return reply.code(204).send();
    });
    app.get<{ Params: { id: string }; Querystring: { path?: string } }>(route, async (req, reply) => {
      guard(req);
      const { limit, offset } = pagination(req.query);
      reply.header("Cache-Control", "no-store");
      return browser.list({ kind, ownerId: req.params.id }, req.query.path ?? "", limit, offset);
    });
    app.get<{ Params: { id: string }; Querystring: { path?: string } }>(`${route}/download`, async (req, reply) => {
      guard(req);
      const { stream, name } = await browser.download({ kind, ownerId: req.params.id }, req.query.path ?? "");
      const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
      reply.header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16))}`);
      reply.header("Cache-Control", "no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      // These are live files: do not promise a Content-Length that a concurrent edit can invalidate.
      const disconnected = () => stream.destroy();
      reply.raw.once("close", disconnected);
      stream.once("close", () => reply.raw.off("close", disconnected));
      return reply.type("application/octet-stream").send(stream);
    });
    app.post<{ Params: { id: string } }>(`${route}/open`, async (req, reply) => {
      guard(req);
      const body = objectBody(req.body);
      await browser.openFolder({ kind, ownerId: req.params.id }, body.path ?? "");
      return reply.code(204).send();
    });
  }
}
