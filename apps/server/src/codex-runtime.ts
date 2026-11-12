import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, chmodSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { CodexLoginStatus, DiscoveredModel } from "./contracts.js";
import { TEST_PROMPT } from "./provider-inference.js";
import { ConnectionError } from "./model-providers.js";

export interface CodexAdapter {
  status(id: string): Promise<CodexLoginStatus>;
  login(id: string, deviceCode: boolean): Promise<CodexLoginStatus>;
  cancel(id: string): Promise<void>;
  logout(id: string): Promise<void>;
  models(id: string): Promise<DiscoveredModel[]>;
  test(id: string, modelId: string, signal: AbortSignal): Promise<string>;
  hasCredential(id: string): boolean;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}
export type CodexLauncher = (home: string) => ChildProcessWithoutNullStreams;
const require = createRequire(import.meta.url);
export const launchCodex: CodexLauncher = (home) => {
  const targets: Record<string, string> = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target)
    throw new ConnectionError(
      "Bundled Codex is unavailable on this platform.",
      503,
    );
  let binary: string;
  try {
    const root = dirname(
      require.resolve(
        `@openai/codex-${process.platform}-${process.arch}/package.json`,
      ),
    );
    binary = join(
      root,
      "vendor",
      target,
      "bin",
      process.platform === "win32" ? "codex.exe" : "codex",
    );
  } catch {
    throw new ConnectionError(
      "Bundled Codex is missing. Run npm ci with optional dependencies enabled.",
      503,
    );
  }
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(CODEX_|OPENAI_)/.test(key)) delete env[key];
  env.CODEX_HOME = home;
  return spawn(
    binary,
    [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      'model_provider="openai"',
      "-c",
      'forced_login_method="chatgpt"',
    ],
    {
      cwd: home,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

class CodexClient {
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private activeTest?: {
    threadId: string;
    text: string;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  };
  private buffer = "";
  private stopped = false;
  private idle?: NodeJS.Timeout;
  private loginTimer?: NodeJS.Timeout;
  private loginId?: string;
  private loginStarting = false;
  private earlyCompletion?: { loginId: string; success: boolean };
  readonly exited: Promise<void>;
  private loginResult: CodexLoginStatus = { status: "disconnected" };
  readonly ready: Promise<void>;
  constructor(
    private proc: ChildProcessWithoutNullStreams,
    private onStop: () => void,
    private rpcTimeout: number,
    private idleMs: number,
  ) {
    this.exited = new Promise((resolve) => proc.once("close", () => resolve()));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", this.onData);
    // Drain stderr without recording it: runtime messages may contain private auth details.
    proc.stderr.resume();
    proc.stdin.on("error", this.onFailure);
    proc.on("error", this.onFailure);
    proc.on("exit", this.onFailure);
    this.ready = this.rpc("initialize", {
      clientInfo: { name: "ufai", title: "ufAI", version: "0.1.0" },
    })
      .then(() => {
        this.send({ method: "initialized" });
      })
      .catch((error) => {
        this.stop();
        throw error;
      });
    this.touch();
  }
  private touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (
        this.loginResult.status === "pending" ||
        this.pending.size ||
        this.activeTest
      )
        this.touch();
      else this.stop();
    }, this.idleMs);
    this.idle.unref();
  }
  private send(value: unknown) {
    if (this.stopped || this.proc.stdin.writableLength > 64 * 1024)
      throw new ConnectionError(
        "Codex is unavailable. Retry the connection.",
        503,
      );
    this.proc.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private onData = (chunk: string) => {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) {
      this.stop();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.stop();
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.stop();
        return;
      }
      const message = parsed as Record<string, unknown>;
      const params = object(message.params);
      if (this.activeTest && message.method && message.id !== undefined) {
        this.activeTest.reject(
          new ConnectionError(
            "Codex requested a tool or approval during the text-only test.",
          ),
        );
        this.stop();
        return;
      }
      if (this.activeTest && params.threadId === this.activeTest.threadId) {
        const item = object(params.item);
        if (
          message.method === "item/agentMessage/delta" &&
          typeof params.delta === "string"
        ) {
          this.activeTest.text += params.delta;
          if (this.activeTest.text.length > 64 * 1024) {
            this.stop();
            return;
          }
        }
        if (
          (message.method === "item/started" &&
            item.type !== "agentMessage" &&
            item.type !== "reasoning" &&
            item.type !== "userMessage") ||
          (message.id !== undefined && message.method)
        ) {
          this.activeTest.reject(
            new ConnectionError(
              "Codex requested a tool during the text-only model test.",
            ),
          );
          this.stop();
          return;
        }
        if (
          message.method === "item/completed" &&
          item.type === "agentMessage" &&
          typeof item.text === "string"
        )
          this.activeTest.text = item.text;
        if (message.method === "turn/completed") {
          const turn = object(params.turn);
          if (turn.status === "completed" && this.activeTest.text.trim())
            this.activeTest.resolve(this.activeTest.text.trim().slice(0, 300));
          else
            this.activeTest.reject(
              new ConnectionError(
                "Codex did not complete a text reply. Retry the model test.",
              ),
            );
        }
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const request = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error)
          request.reject(
            new ConnectionError(
              "Codex could not complete this request. Retry, reconnect, or use device-code sign-in.",
            ),
          );
        else request.resolve(message.result);
      } else if (
        message.method === "account/login/completed" &&
        this.loginStarting &&
        typeof params.loginId === "string" &&
        typeof params.success === "boolean"
      ) {
        this.earlyCompletion = {
          loginId: params.loginId as string,
          success: params.success as boolean,
        };
      } else if (
        message.method === "account/login/completed" &&
        this.loginId &&
        params.loginId === this.loginId &&
        typeof params.success === "boolean"
      ) {
        clearTimeout(this.loginTimer);
        this.loginId = undefined;
        this.loginResult = params.success
          ? { status: "connected" }
          : {
              status: "error",
              error: "Sign-in did not complete. Retry or use a device code.",
            };
      } else if (
        message.method === "account/updated" &&
        this.loginResult.status !== "pending" &&
        !this.loginStarting
      ) {
        this.loginResult = {
          status: params.authMode === "chatgpt" ? "connected" : "disconnected",
        };
      }
    }
  };
  private onFailure = () => {
    this.stop();
  };
  private rpc(
    method: string,
    params: unknown = {},
    timeoutMs = this.rpcTimeout,
  ): Promise<unknown> {
    if (this.stopped)
      return Promise.reject(
        new ConnectionError("Codex stopped. Retry the connection.", 503),
      );
    if (this.pending.size >= 16)
      return Promise.reject(
        new ConnectionError("Codex is busy. Please retry shortly.", 429),
      );
    this.touch();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ConnectionError(
            "Codex timed out. Retry or use device-code sign-in.",
            504,
          ),
        );
        this.stop();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  async status(
    deadline = Date.now() + this.rpcTimeout,
  ): Promise<CodexLoginStatus> {
    await this.ready;
    if (this.loginStarting) return { status: "pending" };
    if (
      this.loginResult.status === "pending" ||
      this.loginResult.status === "error"
    ) {
      this.touch();
      return this.loginResult;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new ConnectionError("Codex timed out. Retry the connection.", 504);
    const result = object(
      await this.rpc("account/read", { refreshToken: false }, remaining),
    );
    this.loginResult = {
      status:
        object(result.account).type === "chatgpt"
          ? "connected"
          : "disconnected",
    };
    return this.loginResult;
  }
  async login(deviceCode: boolean): Promise<CodexLoginStatus> {
    await this.ready;
    if (this.loginStarting)
      throw new ConnectionError(
        "Sign-in is already starting. Please wait.",
        409,
      );
    this.loginStarting = true;
    this.earlyCompletion = undefined;
    try {
      await this.cancel();
      const result = object(
        await this.rpc("account/login/start", {
          type: deviceCode ? "chatgptDeviceCode" : "chatgpt",
        }),
      );
      const url = result?.authUrl ?? result?.verificationUrl;
      if (typeof result?.loginId !== "string" || typeof url !== "string")
        throw new ConnectionError("Codex returned an invalid login response.");
      try {
        const parsed = new URL(url);
        if (
          parsed.protocol !== "https:" ||
          parsed.username ||
          parsed.password ||
          !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(
            parsed.hostname,
          )
        )
          throw new Error();
      } catch {
        throw new ConnectionError("Codex returned an invalid login URL.");
      }
      this.loginId = result.loginId;
      this.loginResult = {
        status: "pending",
        authUrl: url,
        ...(typeof result.userCode === "string"
          ? { userCode: result.userCode }
          : {}),
      };
      // Completion can follow the RPC response in the same stdout chunk.
      const early = this.earlyCompletion as
        | { loginId: string; success: boolean }
        | undefined;
      if (early && early.loginId === this.loginId) {
        this.loginId = undefined;
        this.loginResult = early.success
          ? { status: "connected" }
          : {
              status: "error",
              error: "Sign-in did not complete. Retry or use a device code.",
            };
      } else {
        this.loginTimer = setTimeout(() => {
          void this.cancel().catch(() => this.stop());
        }, 10 * 60_000);
        this.loginTimer.unref();
      }
      return this.loginResult;
    } finally {
      this.loginStarting = false;
      this.earlyCompletion = undefined;
    }
  }

  async cancel() {
    await this.ready;
    if (this.loginId) {
      const loginId = this.loginId;
      this.loginId = undefined;
      clearTimeout(this.loginTimer);
      this.loginResult = { status: "disconnected" };
      await this.rpc("account/login/cancel", { loginId });
    }
  }
  async logout() {
    await this.ready;
    await this.cancel();
    await this.rpc("account/logout");
    this.loginResult = { status: "disconnected" };
  }
  async models(): Promise<DiscoveredModel[]> {
    const deadline = Date.now() + this.rpcTimeout;
    if ((await this.status(deadline)).status !== "connected")
      throw new ConnectionError(
        "Sign in with ChatGPT to fetch available Codex models.",
        401,
      );
    const models: DiscoveredModel[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new ConnectionError("Codex model discovery timed out.", 504);
      const result = object(
        await this.rpc(
          "model/list",
          { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
          remaining,
        ),
      );
      if (!Array.isArray(result?.data))
        throw new ConnectionError("Codex returned an invalid model list.");
      for (const value of result.data as unknown[]) {
        const model = object(value);
        if (
          !model ||
          model.hidden ||
          typeof model.model !== "string" ||
          !model.model.trim() ||
          model.model.length > 200
        )
          continue;
        models.push({
          id: model.model,
          name:
            typeof model.displayName === "string"
              ? model.displayName.slice(0, 300)
              : model.model,
          contextWindow: null,
          maxOutputTokens: null,
        });
      }
      if (models.length > 5000)
        throw new ConnectionError("Codex returned too many models.");
      if (!result.nextCursor)
        return [...new Map(models.map((m) => [m.id, m])).values()];
      if (
        typeof result.nextCursor !== "string" ||
        cursors.has(result.nextCursor)
      )
        throw new ConnectionError("Codex returned invalid model pagination.");
      cursor = result.nextCursor;
      cursors.add(result.nextCursor);
    }
    throw new ConnectionError("Codex returned too many model pages.");
  }
  async test(modelId: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted)
      throw new ConnectionError("The model test was cancelled.", 504);
    const abort = () => {
      this.stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if ((await this.status()).status !== "connected")
        throw new ConnectionError(
          "Sign in with ChatGPT before testing a Codex model.",
          401,
        );
      const result = object(
        await this.rpc("thread/start", {
          model: modelId,
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          baseInstructions:
            "You are a connection test. Reply with OK. Do not use tools.",
          developerInstructions:
            "Reply with a short text answer only. Do not access files or run tools.",
          config: {
            web_search: "disabled",
            features: {
              shell_tool: false,
              apply_patch_freeform: false,
              multi_agent: false,
              apps: false,
              hooks: false,
              goals: false,
              memories: false,
            },
            mcp_servers: {},
          },
        }),
      );
      const threadId = object(result.thread).id;
      if (typeof threadId !== "string")
        throw new ConnectionError("Codex returned an invalid test thread.");
      let resolve!: (text: string) => void;
      let reject!: (error: Error) => void;
      const completed = new Promise<string>((a, b) => {
        resolve = a;
        reject = b;
      });
      // Attach immediately: notifications may share a chunk with the turn/start response.
      void completed.catch(() => {});
      this.activeTest = { threadId, text: "", resolve, reject };
      await this.rpc("turn/start", {
        threadId,
        model: modelId,
        input: [{ type: "text", text: TEST_PROMPT }],
        approvalPolicy: "never",
      });
      return await completed;
    } finally {
      signal.removeEventListener("abort", abort);
      this.activeTest = undefined;
      // Ephemeral test conversations and any interrupted work live only in this process.
      await this.stop();
    }
  }
  stop() {
    if (this.stopped) return this.exited;
    this.stopped = true;
    this.activeTest?.reject(
      new ConnectionError(
        "Codex test stopped or was cancelled. Retry when ready.",
        503,
      ),
    );
    clearTimeout(this.idle);
    clearTimeout(this.loginTimer);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new ConnectionError("Codex stopped. Retry the connection.", 503),
      );
    }
    this.pending.clear();
    this.proc.stdout.removeListener("data", this.onData);
    this.proc.stdout.resume();
    this.proc.stdin.end();
    this.proc.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (this.proc.exitCode === null && this.proc.signalCode === null)
        this.proc.kill("SIGKILL");
    }, 2000);
    killTimer.unref();
    this.proc.once("close", () => clearTimeout(killTimer));
    this.onStop();
    return this.exited;
  }
}

export class CodexRuntime implements CodexAdapter {
  private clients = new Map<string, CodexClient>();
  private closed = false;
  private owned = new Set<CodexClient>();
  constructor(
    private directory: string,
    private launcher: CodexLauncher = launchCodex,
    private rpcTimeout = 15_000,
    private idleMs = 60_000,
  ) {}
  private client(id: string) {
    if (this.closed) throw new ConnectionError("Codex is shutting down.", 503);
    let client = this.clients.get(id);
    if (client) return client;
    if (this.clients.size >= 3)
      throw new ConnectionError(
        "Other Codex connections are busy. Please retry shortly.",
        429,
      );
    const home = join(this.directory, id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    chmodSync(home, 0o700);
    client = new CodexClient(
      this.launcher(home),
      () => this.clients.delete(id),
      this.rpcTimeout,
      this.idleMs,
    );
    this.clients.set(id, client);
    this.owned.add(client);
    void client.exited.then(() => this.owned.delete(client!));
    return client;
  }
  hasCredential(id: string) {
    return existsSync(join(this.directory, id, "auth.json"));
  }
  status(id: string) {
    return this.client(id).status();
  }
  login(id: string, deviceCode: boolean) {
    return this.client(id).login(deviceCode);
  }
  cancel(id: string) {
    return this.clients.get(id)?.cancel() ?? Promise.resolve();
  }
  logout(id: string) {
    return this.client(id).logout();
  }
  models(id: string) {
    return this.client(id).models();
  }
  test(id: string, modelId: string, signal: AbortSignal) {
    return this.client(id).test(modelId, signal);
  }
  async remove(id: string) {
    await this.clients.get(id)?.stop();
    await rm(join(this.directory, id), { recursive: true, force: true });
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.owned].map((client) => client.stop()));
  }
}
