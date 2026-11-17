import { redactSecrets } from "./vault.js";
import catalog from "@ufai/theme-catalog" with { type: "json" };
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContext, type Page, type CDPSession, type Dialog, type FileChooser, type Download, type Locator } from "playwright";
import type Database from "better-sqlite3";
import type { WebSocket } from "ws";
import type { ManagedFiles } from "./managed-files.js";
import type { Skills } from "./skills.js";
import { browserSkillId } from "./skill-defaults.js";
import { managedDirectory, managedFile } from "./host-paths.js";
import { ConnectionError } from "./model-providers.js";
import type { BrowserAction, BrowserDownload, BrowserState, BrowserTab } from "./browser-types.js";

const viewport = { width: 1280, height: 800 };
const maxTabs = 30;
const maxQueue = 64;
function fail(message: string, status = 409): never { throw new ConnectionError(message, status); }
interface Viewer { id: string; socket: WebSocket }
interface Session {
  agentId: string; context?: BrowserContext; launching?: Promise<void>;
  pages: Map<string, Page>; tabs: BrowserTab[]; activeTabId: string | null;
  controller: string | null; viewers: Map<string, Viewer>;
  dialog?: Dialog; chooser?: FileChooser;
  onDialog?: () => void; blockedAction?: Promise<void>;
  downloads: BrowserDownload[]; transfers: Set<Promise<void>>; pendingDownloads: Set<Download>;
  status: BrowserState["status"]; error: string | null;
  tail: Promise<unknown>; queued: number; closing: boolean;
  saveTimer?: ReturnType<typeof setTimeout>;
  capture?: { page: Page; cdp: CDPSession }; captureWork?: Promise<void>;
  incoming: Set<AbortController>;
  monitors: Set<CDPSession>;
  downloadPath?: string;
  cookiesPath?: string; cookieSave?: Promise<void>;
  frame?: string;
  metadataSerial: number;
  metadataWork?: ReturnType<typeof setTimeout>;
  privateValues?: Set<string>;
  privateFields?: Map<Page, Locator[]>;
}
export interface BrowserOptions {
  /** Injectable launch adapter for fixtures; production uses pinned Chromium. */
  launch?: typeof chromium.launchPersistentContext;
  maxTransferBytes?: number;
}
export class BrowserService {
  private sessions = new Map<string, Session>();
  private stopped = false;
  readonly maxTransferBytes: number;
  constructor(readonly db: Database.Database, private files: ManagedFiles, private skills: Skills,
    private changed: (workspaceId: string) => void, private options: BrowserOptions = {}) {
    this.maxTransferBytes = options.maxTransferBytes ?? 256 * 1024 * 1024;
  }
  redact<T>(id: string, result: T): T {
    return redactSecrets(result, this.sessions.get(id)?.privateValues ?? []);
  }
  fillSecret(id: string, ref: string, value: string, signal: AbortSignal) {
    return this.enqueue(id, undefined, true, signal, async s => {
      if (s.dialog) fail("Handle the open website dialog first.");
      const p = this.page(s);
      s.privateValues ??= new Set(); s.privateFields ??= new Map();
      const fields = s.privateFields.get(p) ?? [];
      if (fields.length >= 64 || s.privateValues.size >= 256) fail("Close this browser session before using more secrets.");
      const field = p.getByRef(ref);
      // Record before filling: a failed/cancelled operation can already have effects.
      s.privateValues.add(value); fields.push(field); s.privateFields.set(p, fields);
      try { await field.fill(value, { signal }); }
      catch { fail("Private fill failed. Inspect the page before retrying; effects may have occurred."); }
      return { filled: true };
    });
  }
  private agent(id: string, requireEnabled = true) {
    if (this.stopped) fail("Browsers are shutting down.", 503);
    const agent = this.db.prepare("SELECT id,workspaceId FROM agents WHERE id=?").get(id) as { id: string; workspaceId: string } | undefined;
    if (!agent) fail("Agent not found.", 404);
    this.files.assertAvailable(agent.workspaceId, id);
    if (requireEnabled && !this.skills.isEnabled(id, browserSkillId)) fail("The browser skill is disabled for this agent.", 403);
    return agent;
  }
  assertEnabled(id: string) { this.agent(id); }
  private session(id: string) {
    let s = this.sessions.get(id);
    if (!s) {
      const saved = this.db.prepare("SELECT tabs,activeTabId FROM browser_sessions WHERE agentId=?").get(id) as { tabs: string; activeTabId: string | null } | undefined;
      s = { agentId: id, pages: new Map(), tabs: saved ? JSON.parse(saved.tabs) : [], activeTabId: saved?.activeTabId ?? null,
        controller: null, viewers: new Map(), downloads: [], transfers: new Set(), pendingDownloads: new Set(),
        status: "idle", error: null, metadataSerial: 0, incoming: new Set(), monitors: new Set(), tail: Promise.resolve(), queued: 0, closing: false };
      this.sessions.set(id, s);
    }
    return s;
  }
  state(id: string): BrowserState {
    this.agent(id, false);
    const enabled = this.skills.isEnabled(id, browserSkillId);
    const s = this.session(id);
    return { enabled, status: s.status, error: s.error, tabs: enabled ? s.tabs : [], activeTabId: enabled ? s.activeTabId : null,
      controller: enabled ? s.controller : null,
      dialog: enabled && s.dialog ? { type: s.dialog.type(), message: this.redact(id, s.dialog.message()).slice(0, 4000), defaultValue: this.redact(id, s.dialog.defaultValue()).slice(0, 4000) } : null,
      fileChooser: enabled && s.chooser ? { multiple: s.chooser.isMultiple() } : null,
      downloads: enabled ? s.downloads.map(d => ({ ...d })) : [], viewport };
  }
  async inspect(id: string) {
    this.agent(id); const s = this.session(id);
    if (s.context) await this.refreshMetadata(s);
    return this.state(id);
  }
  private broadcast(s: Session) {
    let state: BrowserState;
    try { state = this.state(s.agentId); } catch { return; }
    const data = JSON.stringify({ type: "state", state });
    for (const viewer of s.viewers.values()) this.send(viewer.socket, data);
  }
  private send(socket: WebSocket, data: string) {
    if (socket.readyState === 1 && socket.bufferedAmount < 2 * 1024 * 1024) socket.send(data);
  }
  private save(s: Session) {
    clearTimeout(s.saveTimer); s.saveTimer = undefined;
    if (!this.db.prepare("SELECT 1 FROM agents WHERE id=?").get(s.agentId)) return;
    this.db.prepare(`INSERT INTO browser_sessions(agentId,tabs,activeTabId,updatedAt) VALUES(?,?,?,?)
      ON CONFLICT(agentId) DO UPDATE SET tabs=excluded.tabs,activeTabId=excluded.activeTabId,updatedAt=excluded.updatedAt`)
      .run(s.agentId, JSON.stringify(s.tabs), s.activeTabId, new Date().toISOString());
    void this.persistSessionCookies(s).catch(() => {});
  }
  private persistSessionCookies(s: Session): Promise<void> {
    if (s.cookieSave) return s.cookieSave;
    const context = s.context, path = s.cookiesPath;
    if (!context || !path) return Promise.resolve();
    s.cookieSave = (async () => {
      // Chromium discards session cookies on normal exit. Retain them for backend restarts;
      // the website still decides whether a restored login remains valid.
      const cookies = (await context.cookies()).filter(cookie => cookie.expires === -1);
      await managedDirectory(dirname(path));
      const staged = `${path}-${randomUUID()}`;
      try { await writeFile(staged, JSON.stringify(cookies), { mode: 0o600, flag: "wx" }); await rename(staged, path); }
      finally { await rm(staged, { force: true }); }
    })().finally(() => { s.cookieSave = undefined; });
    return s.cookieSave;
  }
  private metadata(s: Session) {
    if (s.closing || s.metadataWork) return;
    s.metadataWork = setTimeout(() => {
      s.metadataWork = undefined;
      void this.refreshMetadata(s).catch(() => {});
    }, 100);
  }
  private async refreshMetadata(s: Session) {
    const sequence = ++s.metadataSerial;
    const tabs = await Promise.all([...s.pages].map(async ([id, p]) => ({ id, url: this.redact(s.agentId, p.url()).slice(0, 4096), title: this.redact(s.agentId, (s.dialog ? s.tabs.find(t => t.id === id)?.title ?? "" : await p.title().catch(() => ""))).slice(0, 300) })));
    if (s.closing || !s.context || sequence !== s.metadataSerial) return;
    s.tabs = tabs;
    if (!s.pages.has(s.activeTabId ?? "")) s.activeTabId = tabs[0]?.id ?? null;
    if (!s.saveTimer) s.saveTimer = setTimeout(() => { if (!s.closing) this.save(s); }, 250);
    this.broadcast(s);
    void this.capture(s);
  }
  private watchPage(s: Session, p: Page, id: string = randomUUID()) {
    if ([...s.pages.values()].includes(p)) return;
    if (s.pages.size >= maxTabs) { void p.close().catch(() => {}); return; }
    s.pages.set(id, p);
    void this.monitorDownloads(s, p);
    s.activeTabId = id;
    p.on("framenavigated", () => this.metadata(s));
    p.on("domcontentloaded", () => this.metadata(s));
    p.on("load", () => this.metadata(s));
    p.on("close", () => {
      s.pages.delete(id);
      s.privateFields?.delete(p);
      if (s.dialog?.page() === p) { s.dialog = undefined; s.blockedAction = undefined; }
      if (s.chooser?.page() === p) s.chooser = undefined;
      if (s.activeTabId === id) s.activeTabId = s.pages.keys().next().value ?? null;
      this.metadata(s);
    });
    p.on("crash", () => { s.error = "A browser tab crashed. Reload it or open a new tab."; this.broadcast(s); });
    p.on("dialog", dialog => { s.dialog = dialog; s.onDialog?.(); this.broadcast(s); });
    p.on("filechooser", chooser => { s.chooser = chooser; this.broadcast(s); });
    p.on("download", download => this.download(s, download));
    this.metadata(s);
  }
  private async launch(s: Session) {
    if (s.context) return;
    if (s.launching) return s.launching;
    s.launching = (async () => {
      this.agent(s.agentId); s.status = "starting"; s.error = null; this.broadcast(s);
      const location = await this.files.repair("agent", s.agentId);
      if (location.state !== "ready") fail("Repair the agent folder before starting Browser.");
      await this.files.verifyAgentDirectory(s.agentId);
      const profile = await managedDirectory(join(dirname(location.path), "browser", "profile"), true);
      s.downloadPath = await managedDirectory(join(dirname(location.path), "browser", "downloads"), true);
      s.cookiesPath = join(dirname(profile), "session-cookies.json");
      const tabs = [...s.tabs]; const active = s.activeTabId;
      try {
        const context = await (this.options.launch ?? chromium.launchPersistentContext.bind(chromium))(profile, {
          headless: true, viewport, acceptDownloads: true, chromiumSandbox: true, timeout: 15000, downloadsPath: s.downloadPath,
        });
        s.context = context; s.pages.clear();
        try {
          await managedFile(s.cookiesPath);
          await context.addCookies(JSON.parse(await readFile(s.cookiesPath, "utf8")));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000);
        const first = context.pages()[0] ?? await context.newPage();
        // Browser profiles hold website data; our manifest explicitly restores tab order/selection.
        for (const p of context.pages()) if (p !== first) await p.close();
        for (let index = 0; index < Math.max(1, Math.min(tabs.length, maxTabs)); index++) {
          const saved = tabs[index]; const p = index === 0 ? first : await context.newPage();
          this.watchPage(s, p, saved?.id);
          if (saved?.url && saved.url !== "about:blank") {
            try { await p.goto(this.url(saved.url), { waitUntil: "domcontentloaded" }); } catch { /* Keep failed restored tabs visible and retryable. */ }
          }
        }
        if (active && s.pages.has(active)) s.activeTabId = active;
        context.on("page", p => this.watchPage(s, p));
        context.on("close", () => {
          if (s.context !== context) return;
          s.context = undefined;
          if (!s.closing) { s.status = "error"; s.error = "Browser stopped. Retry to restore saved tabs and website data."; this.broadcast(s); }
        });
        s.status = "ready"; await this.refreshMetadata(s);
      } catch (error) {
        await s.context?.close().catch(() => {}); s.context = undefined;
        s.status = "error";
        s.error = error instanceof Error && /Executable doesn't exist|browser executable/i.test(error.message)
          ? "Chromium is not installed. Run npm run browser:install on the ufAI computer, then Retry."
          : "Browser could not start. Check Chromium dependencies and OS sandbox support, then Retry.";
        this.broadcast(s); throw new ConnectionError(s.error, 503);
      }
    })().finally(() => { s.launching = undefined; });
    return s.launching;
  }
  private url(value: string) {
    let url: URL;
    try { url = new URL(value); } catch { return fail("Enter a complete HTTP(S) URL.", 400); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) fail("Browser navigation requires an HTTP(S) URL without embedded credentials.", 400);
    return url.href;
  }
  private enqueue<T>(id: string, viewerId: string | undefined, mutation: boolean, signal: AbortSignal | undefined, action: (s: Session) => Promise<T>): Promise<T> {
    this.agent(id); const s = this.session(id);
    if (s.closing) fail("Browser is closing.");
    if (s.queued >= maxQueue) fail("Browser is busy. Retry shortly.", 429);
    s.queued++;
    const work = s.tail.catch(() => {}).then(async () => {
      signal?.throwIfAborted(); this.agent(id);
      if (s.closing) fail("Browser is closing.");
      if (viewerId && !s.viewers.has(viewerId)) fail("Browser viewer disconnected.");
      if (mutation && (viewerId ? s.controller !== viewerId : s.controller !== null))
        fail(viewerId ? "Take control before interacting with Browser." : "The user is controlling Browser. Continue other work until they hand back control.");
      await this.launch(s);
      signal?.throwIfAborted(); this.agent(id);
      const stopLoading = () => { const p = s.pages.get(s.activeTabId ?? ""); if (p) void p.evaluate(() => window.stop()).catch(() => {}); };
      signal?.addEventListener("abort", stopLoading, { once: true });
      try { const result = await action(s); signal?.throwIfAborted(); return result; }
      catch (error) {
        signal?.throwIfAborted();
        if (error instanceof ConnectionError) throw error;
        const detail = this.redact(id, error instanceof Error ? error.message : "Unknown browser failure");
        throw new ConnectionError(/Timeout|timed out/i.test(detail)
          ? "Browser action timed out. Inspect the current page before retrying; effects may have occurred."
          : `Browser action failed. Inspect the current page or tabs before retrying: ${detail.slice(0, 500)}`, 409);
      }
      finally { signal?.removeEventListener("abort", stopLoading); await this.refreshMetadata(s); }
    });
    s.tail = work; void work.finally(() => { s.queued--; }).catch(() => {});
    return work;
  }
  async start(id: string) { return this.enqueue(id, undefined, false, undefined, async () => this.state(id)); }
  async control(id: string, viewerId: string, take: boolean) {
    return this.enqueue(id, viewerId, false, undefined, async s => {
      if (take && s.controller && s.controller !== viewerId) fail("Another browser viewer has control.");
      if (take) s.controller = viewerId;
      else if (s.controller === viewerId) s.controller = null;
      this.broadcast(s); return this.state(id);
    });
  }
  private page(s: Session) { const p = s.pages.get(s.activeTabId ?? ""); if (!p) fail("Open a browser tab first."); return p; }
  private async interaction(s: Session, operation: () => Promise<unknown>) {
    let opened!: () => void;
    const dialog = new Promise<"dialog">(resolve => { opened = () => resolve("dialog"); });
    s.onDialog = opened;
    const work = operation();
    try {
      if (await Promise.race([work.then(() => "done" as const), dialog]) === "dialog") {
        // A native page action waits for modal dismissal. Return the observable dialog so the
        // next agent/user action can answer it, then join the original operation on dismissal.
        s.blockedAction = work.then(() => {}, () => {});
      }
    } finally { if (s.onDialog === opened) s.onDialog = undefined; }
  }
  action(id: string, a: BrowserAction, signal?: AbortSignal, viewerId?: string) {
    return this.enqueue(id, viewerId, !["snapshot", "screenshot", "wait"].includes(a.action), signal, async s => {
      if (a.action === "newTab") { if (s.pages.size >= maxTabs) fail(`Close a tab first (maximum ${maxTabs}).`); const p = await s.context!.newPage(); this.watchPage(s, p); }
      else if (a.action === "selectTab" || a.action === "closeTab") {
        const p = s.pages.get(a.tabId); if (!p) fail("Tab no longer exists.", 404);
        if (a.action === "selectTab") s.activeTabId = a.tabId;
        else { await p.close(); if (!s.pages.size) this.watchPage(s, await s.context!.newPage()); }
      } else {
        const p = this.page(s);
        if (a.action !== "dialog" && s.dialog) fail("Handle the open website dialog before continuing.");
        switch (a.action) {
          case "navigate": await this.interaction(s, () => p.goto(this.url(a.url), { waitUntil: "domcontentloaded", signal })); break;
          case "back": await this.interaction(s, () => p.goBack({ waitUntil: "domcontentloaded", signal })); break;
          case "forward": await this.interaction(s, () => p.goForward({ waitUntil: "domcontentloaded", signal })); break;
          case "reload": await this.interaction(s, () => p.reload({ waitUntil: "domcontentloaded", signal })); break;
          case "snapshot": return { snapshot: Buffer.from(this.redact(id, await p.ariaSnapshot({ mode: "ai", signal, depth: 30 }))).subarray(0, 24000).toString("utf8"), url: p.url() };
          case "screenshot": {
            const folder = (await this.files.repair("agent", id)).path;
            const path = join(folder, `Browser-${randomUUID()}.png`);
            const mask = s.privateFields?.get(p) ?? [];
            if (mask.length && (await Promise.all(mask.map(field => field.count().catch(() => 0)))).some(count => count !== 1))
              fail("Cannot safely mask a secret field. Close this tab before taking an agent screenshot.");
            await managedDirectory(folder);
            try { await p.screenshot({ path, type: "png", timeout: 10000, signal, mask, maskColor: catalog.tokens.surface.light }); }
            catch { await rm(path, { force: true }); fail("Screenshot failed. Secret fields could not be safely captured."); }
            return { path };
          }
          case "click":
            if (a.ref) await this.interaction(s, () => p.getByRef(a.ref!).click({ button: a.button, clickCount: a.clickCount, noWaitAfter: true, signal }));
            else { if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x! < 0 || a.y! < 0 || a.x! > viewport.width || a.y! > viewport.height) fail("Supply a snapshot ref or viewport coordinates.", 400); await this.interaction(s, () => p.mouse.click(a.x!, a.y!, { button: a.button, clickCount: a.clickCount })); }
            break;
          case "fill": await p.getByRef(a.ref).fill(a.text, { signal }); break;
          case "select": await p.getByRef(a.ref).selectOption(a.text, { signal }); break;
          case "type": await p.keyboard.insertText(a.text); break;
          case "key": await this.interaction(s, () => p.keyboard.press(a.text)); break;
          case "scroll": await p.mouse.wheel(a.x, a.y); break;
          case "wait": await delay(a.ms, undefined, { signal }); break;
          case "dialog": {
            if (!s.dialog) fail("No website dialog is open.");
            const dialog = s.dialog; s.dialog = undefined;
            if (a.accept) await dialog.accept(a.text); else await dialog.dismiss();
            await s.blockedAction; s.blockedAction = undefined;
            break;
          }
        }
      }
      return { state: this.state(id) };
    }).then(result => "state" in result ? { state: this.state(id) } : result);
  }
  upload(id: string, paths: string[], ref?: string, signal?: AbortSignal, viewerId?: string) {
    return this.enqueue(id, viewerId, true, signal, async s => {
      if (!paths.length || paths.length > 10) fail("Choose 1–10 files.", 400);
      let total = 0;
      for (const path of paths) { const stat = await managedFile(resolve(path)); total += stat.size; }
      if (total > this.maxTransferBytes) fail("Browser upload exceeds the transfer limit.", 413);
      if (ref) { await this.page(s).getByRef(ref).setInputFiles(paths, { signal }); s.chooser = undefined; }
      else { if (!s.chooser) fail("Open a website file chooser first."); const chooser = s.chooser; await chooser.setFiles(paths, { signal }); s.chooser = undefined; }
      return { uploaded: paths.length };
    });
  }
  private async monitorDownloads(s: Session, page: Page) {
    try {
      const cdp = await s.context!.newCDPSession(page);
      s.monitors.add(cdp);
      page.once("close", () => { s.monitors.delete(cdp); void cdp.detach().catch(() => {}); });
      cdp.on("Browser.downloadProgress", event => {
        if (event.receivedBytes > this.maxTransferBytes || event.totalBytes > this.maxTransferBytes)
          void cdp.send("Browser.cancelDownload", { guid: event.guid }).catch(() => {});
      });
      await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: s.downloadPath!, eventsEnabled: true });
    } catch { /* Page closure during attachment is harmless; transfer copy enforces its own bound. */ }
  }
  beginUpload(id: string, viewerId: string) {
    this.agent(id); const s = this.session(id);
    if (!s.viewers.has(viewerId) || s.controller !== viewerId) fail("Take control before uploading files.", 403);
    if (s.incoming.size >= 4) fail("Browser uploads are busy. Retry shortly.", 429);
    const controller = new AbortController(); s.incoming.add(controller);
    let finish!: () => void;
    const work = new Promise<void>(resolve => { finish = resolve; }); s.transfers.add(work);
    return { controller, finish: () => { s.incoming.delete(controller); s.transfers.delete(work); finish(); } };
  }
  private download(s: Session, d: Download) {
    const entry: BrowserDownload = { id: randomUUID(), name: basename(d.suggestedFilename()).replace(/[\\/\u0000-\u001f<>:"|?*]/g, "_").slice(0, 160) || "download", state: "downloading" };
    if (s.pendingDownloads.size >= 4) { void d.cancel().catch(() => {}); return; }
    s.downloads = [...s.downloads.slice(-49), entry]; s.pendingDownloads.add(d); this.broadcast(s);
    const work = (async () => {
      let path: string | undefined;
      try {
        const folder = await managedDirectory(join(this.files.location("agent", s.agentId).path, "Downloads"), true);
        path = join(folder, `${entry.id}-${entry.name}`);
        const input = await d.createReadStream(); if (!input) fail("Download did not produce a file.");
        let size = 0;
        const limit = new Transform({ transform: (chunk: Buffer, _encoding, next) => { size += chunk.length; next(size > this.maxTransferBytes ? new Error("Download exceeds the transfer limit.") : null, chunk); } });
        await pipeline(input, limit, createWriteStream(path, { flags: "wx", mode: 0o600 }));
        entry.path = `Downloads/${basename(path)}`; entry.state = "ready";
        const agent = this.db.prepare("SELECT workspaceId FROM agents WHERE id=?").get(s.agentId) as { workspaceId: string } | undefined;
        if (agent) this.changed(agent.workspaceId);
      } catch (error) { if (path) await rm(path, { force: true }).catch(() => {}); entry.state = "failed"; entry.error = error instanceof Error ? error.message.slice(0, 500) : "Download failed."; }
      finally { await d.delete().catch(() => {}); s.pendingDownloads.delete(d); this.broadcast(s); }
    })();
    s.transfers.add(work); void work.finally(() => s.transfers.delete(work)).catch(() => {});
  }
  attach(id: string, socket: WebSocket) {
    this.agent(id); const s = this.session(id); const viewerId = randomUUID();
    if (s.viewers.size >= 8) fail("Too many browser viewers.", 429);
    s.viewers.set(viewerId, { id: viewerId, socket });
    this.send(socket, JSON.stringify({ type: "hello", viewerId })); this.broadcast(s);
    if (s.frame) this.send(socket, s.frame);
    void this.capture(s);
    socket.on("close", () => this.detach(s, viewerId));
    socket.on("error", () => this.detach(s, viewerId));
    return viewerId;
  }
  private detach(s: Session, id: string) {
    s.viewers.delete(id); if (s.controller === id) s.controller = null;
    this.broadcast(s); void this.capture(s);
  }
  private capture(s: Session) {
    if (s.captureWork) return s.captureWork;
    s.captureWork = (async () => {
      const p = s.pages.get(s.activeTabId ?? "");
      const watching = !s.closing && s.viewers.size > 0 && this.skills.isEnabled(s.agentId, browserSkillId);
      if (s.capture && (!watching || s.capture.page !== p || s.capture.page.isClosed())) {
        const old = s.capture; s.capture = undefined;
        await old.cdp.send("Page.stopScreencast").catch(() => {}); await old.cdp.detach().catch(() => {});
      }
      if (!watching || !p || s.capture || !s.context) return;
      const cdp = await s.context.newCDPSession(p);
      s.capture = { page: p, cdp };
      let last = 0;
      cdp.on("Page.screencastFrame", frame => {
        const now = Date.now();
        if (now - last >= 80) {
          last = now;
          const data = JSON.stringify({ type: "frame", data: frame.data, width: viewport.width, height: viewport.height });
          s.frame = data;
          for (const viewer of s.viewers.values()) this.send(viewer.socket, data);
        }
        void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
    })().catch(() => {}).finally(() => {
      s.captureWork = undefined;
      // A disconnect or tab switch can happen while attaching the CDP session.
      if (s.capture && (s.closing || !s.viewers.size || s.capture.page !== s.pages.get(s.activeTabId ?? ""))) void this.capture(s);
    });
    return s.captureWork;
  }
  enabledChanged(id: string, skillId: string, enabled: boolean) {
    if (skillId !== browserSkillId || enabled) return;
    const s = this.sessions.get(id); if (!s) return;
    s.controller = null;
    for (const v of s.viewers.values()) v.socket.close(4003, "browser skill disabled");
    s.viewers.clear(); void this.capture(s);
  }
  async settleAgents(ids: string[]) {
    await Promise.all(ids.map(async id => {
      const s = this.sessions.get(id); if (!s) return;
      s.closing = true;
      for (const v of s.viewers.values()) v.socket.close(1001, "Browser closing");
      s.viewers.clear(); s.controller = null;
      clearTimeout(s.metadataWork); clearTimeout(s.saveTimer);
      await s.tail.catch(() => {}); await s.launching?.catch(() => {});
      this.save(s);
      await s.cookieSave?.catch(() => {});
      await this.persistSessionCookies(s).catch(() => {});
      await this.capture(s);
      for (const incoming of s.incoming) incoming.abort();
      await Promise.allSettled([...s.pendingDownloads].map(d => d.cancel()));
      await Promise.allSettled([...s.transfers]);
      await s.context?.close().catch(() => {}); s.context = undefined;
      this.sessions.delete(id);
    }));
  }
  async close() { this.stopped = true; await this.settleAgents([...this.sessions.keys()]); }
}
