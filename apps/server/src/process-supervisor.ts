// One guardian per launch: an IPC disconnect kills the owned process tree.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IPty } from "node-pty";
let child: ChildProcessWithoutNullStreams | undefined,
  terminal: IPty | undefined;
let pid: number | undefined,
  stopping = false,
  finished = false,
  pending = false;
let queued: Buffer[] = [],
  queuedBytes = 0;
const send = (message: unknown) => {
  if (process.connected) process.send?.(message);
};
function drain() {
  if (pending || !queued.length) return;
  const bytes = queued.shift()!;
  queuedBytes -= bytes.length;
  pending = true;
  send({ type: "output", data: bytes.toString("base64") });
}
function output(value: Buffer | string) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  for (let i = 0; i < data.length; i += 32768)
    queued.push(data.subarray(i, i + 32768));
  queuedBytes += data.length;
  if (queuedBytes > 65536) {
    child?.stdout.pause();
    child?.stderr.pause();
    terminal?.pause();
  }
  if (queuedBytes > 1024 * 1024) {
    stop();
    send({
      type: "error",
      message: "Process output exceeded backpressure limits.",
    });
  }
  drain();
}
function kill(force = false) {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill",
      ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { stdio: "ignore", windowsHide: true },
    );
    killer.on("error", () => {});
  } else {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch {}
    }
  }
}
function stop() {
  if (stopping) return;
  stopping = true;
  kill();
  setTimeout(() => {
    kill(true);
    if (!process.connected) process.exit();
  }, 2000);
}
function exit(code: number | null, signal?: string | number | null) {
  if (finished) return;
  finished = true;
  // Kill descendants left behind when their foreground parent exits.
  kill();
  const finish = () => {
    if (queued.length || pending) {
      setTimeout(finish, 10);
      return;
    }
    send({
      type: "exit",
      code,
      signal: signal == null ? null : String(signal),
    });
    setTimeout(() => {
      kill(true);
      process.disconnect?.();
      process.exit();
    }, 2050);
  };
  finish();
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("message", async (raw: any) => {
  if (raw.type === "start" && !pid) {
    try {
      if (raw.pty) {
        const pty = await import("node-pty");
        terminal = pty.spawn(raw.file, raw.args, {
          cwd: raw.cwd,
          env: raw.env,
          cols: raw.cols,
          rows: raw.rows,
          name: "xterm-256color",
        });
        pid = terminal.pid;
        terminal.onData(output);
        terminal.onExit((e) => exit(e.exitCode, e.signal));
      } else {
        child = spawn(raw.file, raw.args, {
          cwd: raw.cwd,
          env: raw.env,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: "pipe",
        });
        pid = child.pid;
        child.stdout.on("data", output);
        child.stderr.on("data", output);
        child.on("error", () => {
          send({ type: "error", message: "Cannot start command." });
          exit(null);
        });
        child.on("exit", () => {
          kill();
          const timer = setTimeout(() => kill(true), 2000);
          timer.unref();
        });
        child.on("close", exit);
        child.stdin.on("error", () => {});
      }
      send({ type: "started" });
    } catch {
      send({ type: "error", message: "Cannot start terminal or command." });
      exit(null);
    }
  } else if (raw.type === "ack") {
    pending = false;
    if (queuedBytes < 32768) {
      child?.stdout.resume();
      child?.stderr.resume();
      terminal?.resume();
    }
    drain();
  } else if (raw.type === "input") {
    if (terminal) terminal.write(raw.data);
    else child?.stdin.write(raw.data);
  } else if (raw.type === "resize") terminal?.resize(raw.cols, raw.rows);
  else if (raw.type === "stop") stop();
});
